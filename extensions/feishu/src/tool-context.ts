import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";

/**
 * If the calling agent has an account id, copy it into tool params as accountId
 * (unless the caller already provided one).
 *
 * This allows Feishu tools that are registered at startup (and therefore can't
 * capture a per-agent client) to select the right Feishu account at execution
 * time.
 */
export const resolveFeishuAccountForToolContext = async (ctx: {
  toolName: string;
  params: Record<string, unknown>;
  agentId?: string;
  sessionKey?: string;
}) => {
  const toolName = ctx.toolName;
  if (typeof toolName !== "string" || !toolName.startsWith("feishu_")) {
    return { blocked: false, params: ctx.params };
  }

  // If caller already specified an accountId, keep it.
  const existing = (ctx.params as Record<string, unknown> | undefined)?.accountId;
  if (typeof existing === "string" && existing.trim()) {
    return { blocked: false, params: ctx.params };
  }

  // NOTE: Plugin hook context does not currently expose agentAccountId.
  // We still keep a safe fallback: inject default accountId unless caller already provided one.
  return {
    blocked: false,
    params: { ...(ctx.params ?? {}), accountId: DEFAULT_ACCOUNT_ID },
  };
};
