// Feishu plugin module implements reasoning preview behavior.
import { resolveFeishuConfigReasoningDefault } from "./agent-config.js";
<<<<<<< HEAD
import { getSessionEntry } from "./bot-runtime-api.js";
=======
import { loadSessionStore, resolveSessionStoreEntry } from "./bot-runtime-api.js";
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
import type { ClawdbotConfig } from "./bot-runtime-api.js";

export function resolveFeishuReasoningPreviewEnabled(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  storePath: string;
  sessionKey?: string;
}): boolean {
  const configDefault = resolveFeishuConfigReasoningDefault(params.cfg, params.agentId);

  if (!params.sessionKey) {
    return configDefault === "stream";
  }

  try {
<<<<<<< HEAD
    const level = getSessionEntry({
      storePath: params.storePath,
      sessionKey: params.sessionKey,
      readConsistency: "latest",
    })?.reasoningLevel;
=======
    const store = loadSessionStore(params.storePath, { skipCache: true });
    const level = resolveSessionStoreEntry({ store, sessionKey: params.sessionKey }).existing
      ?.reasoningLevel;
>>>>>>> e84b719c996d5700bd3163008a0f5d78ce2423df
    if (level === "on" || level === "stream" || level === "off") {
      return level === "stream";
    }
  } catch {
    return false;
  }
  return configDefault === "stream";
}
