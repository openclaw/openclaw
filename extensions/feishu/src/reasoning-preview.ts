import { loadSessionStore, resolveSessionStoreEntry } from "./bot-runtime-api.js";
import type { ClawdbotConfig } from "./bot-runtime-api.js";

export function resolveFeishuReasoningPreviewEnabled(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  storePath: string;
  sessionKey?: string;
}): boolean {
  // Resolve config-driven default: per-agent override > hardcoded "off".
  const agentDefault = params.cfg.agents?.list?.find(
    (a) => a.id === params.agentId,
  )?.reasoningDefault;
  const configDefault =
    agentDefault === "on" || agentDefault === "stream" || agentDefault === "off"
      ? agentDefault
      : "off";

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
