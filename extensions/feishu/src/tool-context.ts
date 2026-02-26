import type { BeforeToolCallHook } from "openclaw/plugin-sdk";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";

/**
 * If the calling agent has an account id, copy it into tool params as accountId
 * (unless the caller already provided one).
 *
 * This allows Feishu tools that are registered at startup (and therefore can't
 * capture a per-agent client) to select the right Feishu account at execution
 * time.
 */
export const resolveFeishuAccountForToolContext: BeforeToolCallHook = async (ctx) => {
  const toolName = ctx.toolName;
  if (typeof toolName !== "string" || !toolName.startsWith("feishu_")) {
    return { blocked: false, params: ctx.params };
  }

  // If caller already specified an accountId, keep it.
  const existing = (ctx.params as Record<string, unknown> | undefined)?.accountId;
  if (typeof existing === "string" && existing.trim()) {
    return { blocked: false, params: ctx.params };
  }

  const agentAccountId = ctx.agentAccountId;
  if (!agentAccountId) {
    // Backward-compatible: no agent account context => default account.
    return {
      blocked: false,
      params: { ...(ctx.params ?? {}), accountId: DEFAULT_ACCOUNT_ID },
    };
  }

  const accountId = normalizeAccountId(agentAccountId);
  return {
    blocked: false,
    params: { ...(ctx.params ?? {}), accountId },
  };
};
