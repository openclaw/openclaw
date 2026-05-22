/**
 * capability-utils.ts — 共享工具函数（Capability 层通用模式提取）
 *
 * 抽取多个 Capability 中重复出现的模式：
 *   1. publishSilent      — 发布事件并吞掉错误（fire-and-forget）
 *   2. buildSystemPrompt  — 带上下文/历史的 LLM Prompt 构建
 *   3. paginateList       — 统一分页辅助
 *   4. assertParam        — 必填参数校验（抛 ToolInputError 兼容格式）
 */

import type { EventKernel } from "./event-kernel.js";

// ── 1. publishSilent ──────────────────────────────────────────────────────

/**
 * 发布事件并静默吞掉错误（用于 fire-and-forget 审计/通知事件）。
 * 避免在每个 Capability 中重复 `.catch(() => {})` 链式调用。
 */
export async function publishSilent(
  kernel: EventKernel,
  type: string,
  source: string,
  payload: Record<string, unknown>,
  correlationId?: string,
): Promise<void> {
  await kernel
    .publish(type, source, payload, correlationId ? { correlationId } : undefined)
    .catch(() => {});
}

// ── 2. buildSystemPrompt ──────────────────────────────────────────────────

export type PromptContext = {
  text: string;
  robotName?: string;
  userProfile?: { name?: string; preferredResponseStyle?: string };
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  extraInstructions?: string;
};

/**
 * 构建带上下文的 LLM System Prompt 字符串。
 * 多个 Capability（perceive.intent、reason.chain、comms.stream_reply 等）
 * 各自组装相似的 Prompt 结构，统一到此处避免漂移。
 */
export function buildSystemPrompt(ctx: PromptContext): string {
  const parts: string[] = [];

  if (ctx.robotName) {
    parts.push(`你是 ${ctx.robotName}，一个工业级智能助手。`);
  }

  if (ctx.userProfile?.name) {
    parts.push(`用户：${ctx.userProfile.name}`);
  }

  const style = ctx.userProfile?.preferredResponseStyle;
  if (style === "concise") {
    parts.push("请用简短精炼的语言回复（2-3句为宜）。");
  } else if (style === "detailed") {
    parts.push("请提供详细说明，包含步骤和背景。");
  } else if (style === "structured") {
    parts.push("请用结构化格式回复（列表/标题）。");
  }

  if (ctx.history && ctx.history.length > 0) {
    parts.push("历史对话（最近 5 轮）：");
    const recent = ctx.history.slice(-10);
    parts.push(
      recent.map((h) => `${h.role === "user" ? "用户" : "助手"}：${h.content}`).join("\n"),
    );
  }

  if (ctx.extraInstructions) {
    parts.push(ctx.extraInstructions);
  }

  parts.push(`当前消息：${ctx.text}`);
  return parts.join("\n\n");
}

// ── 3. paginateList ───────────────────────────────────────────────────────

/**
 * 对已加载列表执行内存分页，返回统一的分页结果格式。
 * 避免在 list/query 类 Capability 中各自实现 slice + meta 逻辑。
 */
export function paginateList<T>(
  items: T[],
  limit = 50,
  offset = 0,
): {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  has_more: boolean;
} {
  const safeLimit = Math.max(1, Math.min(limit, 200));
  const safeOffset = Math.max(0, offset);
  const page = items.slice(safeOffset, safeOffset + safeLimit);
  return {
    items: page,
    total: items.length,
    limit: safeLimit,
    offset: safeOffset,
    has_more: safeOffset + safeLimit < items.length,
  };
}

// ── 4. assertParam ────────────────────────────────────────────────────────

/**
 * 必填参数校验：若值为 null/undefined/空字符串则抛出错误信息。
 * 使用方自行 catch 并包装为 ToolInputError 或直接上抛。
 */
export function assertParam(value: unknown, name: string): asserts value is NonNullable<unknown> {
  if (value === null || value === undefined || value === "") {
    throw new Error(`Missing required parameter: ${name}`);
  }
}
