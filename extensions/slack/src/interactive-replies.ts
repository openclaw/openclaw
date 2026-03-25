import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { resolveDefaultSlackAccountId, resolveSlackAccount } from "./accounts.js";

function resolveInteractiveRepliesFromCapabilities(capabilities: unknown): boolean {
  if (!capabilities) {
    return false;
  }
  if (Array.isArray(capabilities)) {
    return capabilities.some(
      (entry) => String(entry).trim().toLowerCase() === "interactivereplies",
    );
  }
  if (typeof capabilities === "object") {
    return (capabilities as { interactiveReplies?: unknown }).interactiveReplies === true;
  }
  return false;
}

export function isSlackInteractiveRepliesEnabled(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): boolean {
  const account = resolveSlackAccount({
    cfg: params.cfg,
    accountId: params.accountId ?? resolveDefaultSlackAccountId(params.cfg),
  });
  return resolveInteractiveRepliesFromCapabilities(account.config.capabilities);
}
