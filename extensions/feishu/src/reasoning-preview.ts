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
    // Fall through to config default.
  }
  // Feishu preview only supports the "stream" variant; "on" (block-mode) has no preview equivalent.
  return configDefault === "stream";
}
