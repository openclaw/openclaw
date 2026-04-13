/**
 * Business Error Code Check Interceptor
 *
 * Checks whether the tools/call return result contains business error codes that require cache cleanup.
 * MCP Server may return business-layer errors within normal JSON-RPC responses,
 * wrapped in result.content[].text, which need to be parsed and evaluated.
 *
 * This interceptor applies to all call invocations.
 */

import { wecomMcpLog } from "../../loggers.js";
import { clearCategoryCache } from "../transport.js";
import type { CallInterceptor, CallContext } from "./types.js";

// ============================================================================
// Constants
// ============================================================================

/**
 * Set of business error codes that trigger cache cleanup
 *
 * These error codes appear in the content text returned by MCP tool calls (business layer),
 * different from JSON-RPC layer error codes, and need additional detection here.
 *
 * - 850002: Bot is not authorized to use the corresponding capability; clear cache to re-fetch config next time
 */
const BIZ_CACHE_CLEAR_ERROR_CODES = new Set([850002]);

// ============================================================================
// Interceptor Implementation
// ============================================================================

export const bizErrorInterceptor: CallInterceptor = {
  name: "biz-error",

  /** Applies to all call invocations */
  match: () => true,

  /** Check return result for business error codes; clear cache if necessary */
  afterCall(ctx: CallContext, result: unknown): unknown {
    checkBizErrorAndClearCache(result, ctx.accountId, ctx.category);
    // Don't modify result; pass through to the next interceptor
    return result;
  },
};

// ============================================================================
// Internal Implementation
// ============================================================================

/**
 * Check if tools/call return result contains business error codes that require cache cleanup
 */
function checkBizErrorAndClearCache(result: unknown, accountId: string, category: string): void {
  if (!result || typeof result !== "object") {
    return;
  }

  const { content } = result as { content?: Array<{ type: string; text?: string }> };
  if (!Array.isArray(content)) {
    return;
  }

  for (const item of content) {
    if (item.type !== "text" || !item.text) {
      continue;
    }
    try {
      const parsed = JSON.parse(item.text) as Record<string, unknown>;
      if (typeof parsed.errcode === "number" && BIZ_CACHE_CLEAR_ERROR_CODES.has(parsed.errcode)) {
        wecomMcpLog.debug(`检测到业务错误码 ${parsed.errcode} (category="${category}")，清理缓存`);
        clearCategoryCache(accountId, category);
        return;
      }
    } catch {
      // text is not JSON format, skip
    }
  }
}
