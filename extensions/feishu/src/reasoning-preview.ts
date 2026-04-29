import { loadSessionStore, resolveAgentConfig, resolveSessionStoreEntry } from "./bot-runtime-api.js";
import type { ClawdbotConfig } from "./bot-runtime-api.js";

export function resolveFeishuReasoningPreviewEnabled(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  storePath: string;
  sessionKey?: string;
}): boolean {
  // Resolve config-driven default using the shared normalized resolver so that
  // agent IDs are matched case-insensitively (matching routing behaviour).
  // Precedence: per-agent reasoningDefault → global agents.defaults.reasoningDefault → "off".
  const agentDefault = resolveAgentConfig(params.cfg, params.agentId)?.reasoningDefault;
  const globalDefault = params.cfg.agents?.defaults?.reasoningDefault;
  const rawDefault = agentDefault ?? globalDefault;
  const configDefault =
    rawDefault === "on" || rawDefault === "stream" || rawDefault === "off" ? rawDefault : "off";

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
