/**
 * 业务错误码检查拦截器
 *
 * 检查 tools/call 返回结果中是否包含需要清理缓存的业务错误码。
 * MCP Server 可能在正常的 JSON-RPC 响应中返回业务层错误，
 * 这些错误被包裹在 result.content[].text 中，需要解析后判断。
 *
 * 此拦截器对所有 call 调用生效。
 */

import { clearCategoryCache } from "../transport.js";
import type { CallInterceptor, CallContext } from "./types.js";

// ============================================================================
// 常量
// ============================================================================

/**
 * 需要触发缓存清理的业务错误码集合
 *
 * 这些错误码出现在 MCP 工具调用返回的 content 文本中（业务层面），
 * 与 JSON-RPC 层面的错误码不同，需要在此处额外检测。
 *
 * - 850002: 机器人未被授权使用对应能力，需清理缓存以便下次重新拉取配置
 */
const BIZ_CACHE_CLEAR_ERROR_CODES = new Set([850002]);

// ============================================================================
// 拦截器实现
// ============================================================================

export const bizErrorInterceptor: CallInterceptor = {
  name: "biz-error",

  /** 对所有 call 调用生效 */
  match: () => true,

  /** 检查返回结果中的业务错误码，必要时清理缓存 */
  afterCall(ctx: CallContext, result: unknown): unknown {
    checkBizErrorAndClearCache(result, ctx.category);
    // 不修改 result，透传给下一个拦截器
    return result;
  },
};

// ============================================================================
// 内部实现
// ============================================================================

/**
 * 检查 tools/call 的返回结果中是否包含需要清理缓存的业务错误码
 */
function checkBizErrorAndClearCache(result: unknown, category: string): void {
  if (!result || typeof result !== "object") return;

  const { content } = result as { content?: Array<{ type: string; text?: string }> };
  if (!Array.isArray(content)) return;

  for (const item of content) {
    if (item.type !== "text" || !item.text) continue;
    try {
      const parsed = JSON.parse(item.text) as Record<string, unknown>;
      if (typeof parsed.errcode === "number" && BIZ_CACHE_CLEAR_ERROR_CODES.has(parsed.errcode)) {
        console.log(`[mcp] 检测到业务错误码 ${parsed.errcode} (category="${category}")，清理缓存`);
        clearCategoryCache(category);
        return;
      }
    } catch {
      // text 不是 JSON 格式，跳过
    }
  }
}
