import { loadSessionStore, resolveSessionStoreEntry } from "./bot-runtime-api.js";
import type { ClawdbotConfig } from "./bot-runtime-api.js";
import { resolveConfigReasoningDefault } from "openclaw/plugin-sdk/agent-config-helpers";

export function resolveFeishuReasoningPreviewEnabled(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  storePath: string;
  sessionKey?: string;
}): boolean {
  const configDefault = resolveConfigReasoningDefault(params.cfg, params.agentId);

  if (!params.sessionKey) {
    // Feishu preview only supports the "stream" variant; "on" (block-mode) has no preview equivalent.
    return configDefault === "stream";
  }

  try {
    const store = loadSessionStore(params.storePath, { skipCache: true });
    const level =
      resolveSessionStoreEntry({ store, sessionKey: params.sessionKey }).existing
        ?.reasoningLevel;
    if (level === "on" || level === "stream" || level === "off") {
      return level === "stream";
    }
  } catch {
    // Fail closed: if the session store is unreadable we cannot confirm a
    // stored "off" override is absent, so don't expose reasoning previews.
    return false;
  }
  // No persisted level found — fall back to config default.
  // Feishu preview only supports the "stream" variant; "on" (block-mode) has no preview equivalent.
  return configDefault === "stream";
}
