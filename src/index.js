/**
 * dsh-law-verify-gate — 法条核验闸门
 *
 * Einstein-OS 出品的 AI 法律文书防幻觉插件：
 * 对文本中的法条引用逐条比对官方库（56,291 条索引 + 元典智库双源），
 * 四态判决（verified / not_found / modified / expired）+ 权威原文片段。
 *
 * 后端：Einstein-OS law-verify-mcp（http://127.0.0.1:18971/verify）
 * 免费额度：每月 100 次 / 按次 ¥0.5 / Pro ¥50 月
 */

import { readFileSync } from 'node:fs';
import { defineTool, ToolArgsError } from '@deepseek-ai/dsh-tools';

const API_BASE = process.env.LAW_VERIFY_API ?? 'http://127.0.0.1:18971';
const POLICY = readFileSync(new URL('../prompts/policy.md', import.meta.url), 'utf8');
const pluginVersion = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8')
).version;

export const name = 'dsh-law-verify-gate';
export const inject = ['systemPrompt', 'tools'];

async function callVerify(text) {
  const res = await fetch(`${API_BASE}/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`法条核验服务 HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

function renderResult(result) {
  const lines = [];
  lines.push(`📋 法条核验完成 —— 抽取引用 ${result.refs_found} 条（计费：${result.billing?.charged ?? '?'}，剩余免费额度 ${result.billing?.free_left ?? '?'} 次）`);
  lines.push('');
  const marks = { verified: '✅', not_found: '⚠️', modified: '🔶', expired: '🔶' };
  for (const r of result.local_check ?? []) {
    lines.push(`${marks[r.status] ?? '·'} 《${r.law}》第${r.article_cn || r.article}条 → ${r.status}`);
    if (r.kb_content) lines.push(`   原文：${r.kb_content.slice(0, 80)}${r.kb_content.length > 80 ? '…' : ''}`);
    if (r.message) lines.push(`   ${r.message}`);
  }
  if (result.official_check?.enriched?.length) {
    lines.push('');
    lines.push('🏛️ 官方补充：');
    for (const e of result.official_check.enriched.slice(0, 3)) {
      lines.push(`   ${e.law}:${e.article} ${e.validity ?? ''} —— ${e.content?.slice(0, 60) ?? ''}`);
    }
  }
  if (result.official_check?.pending?.length) {
    lines.push('');
    lines.push(`⏳ 待官方核验 ${result.official_check.pending.length} 条（后台队列，稍后补齐）`);
  }
  return lines.join('\n');
}

export async function apply(ctx) {
  ctx.systemPrompt.section({
    name: 'dsh-law-verify-gate:policy',
    order: 660,
    interpolate: false,
    text: POLICY,
  });

  ctx.tools.register(
    defineTool({
      name: 'law_verify',
      description:
        '对一段文本中的所有法条引用（《法律名》第X条格式，支持中文数字条号）执行真实性核验：' +
        '逐条比对官方库，返回四态判决（verified 已验证 / not_found 未找到 / modified 已修改 / expired 已失效）' +
        '与权威原文片段。适用于：法律文书完成后的引用核对、AI 生成的法律内容防幻觉检查、' +
        '普法文章引用核验、合同审查中确认援引条款时效性。',
      parameters: {
        text: { type: 'string', required: true, description: '待核验的完整文本（可包含多条法条引用）' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ok: { type: 'boolean', required: true },
            refs_found: { type: 'number', required: true },
            summary: { type: 'string', required: true },
          },
        },
      },
      async execute(args, exec) {
        exec.signal.throwIfAborted();
        const text = (args.text ?? '').trim();
        if (!text) throw new ToolArgsError('text 不能为空');
        let result;
        try {
          result = await callVerify(text);
        } catch (error) {
          throw new ToolArgsError(`法条核验服务不可达（${API_BASE}）：${error.message}`);
        }
        return {
          ok: result.ok ?? true,
          refs_found: result.refs_found ?? 0,
          summary: renderResult(result),
        };
      },
    })
  );

  ctx.tools.register(
    defineTool({
      name: 'law_verify_pricing',
      description: '查询法条核验闸门的计费方案（免费额度/按次/Pro 订阅）。',
      parameters: {},
      output: { schema: { type: 'object', additionalProperties: true } },
      async execute(_args, exec) {
        exec.signal.throwIfAborted();
        const res = await fetch(`${API_BASE}/pricing`, { signal: AbortSignal.timeout(10_000) });
        return res.json();
      },
    })
  );
}
