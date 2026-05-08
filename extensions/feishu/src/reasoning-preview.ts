import { resolveFeishuConfigReasoningDefault } from "./agent-config.js";
import { getSessionEntry, resolveAgentIdFromSessionKey } from "./bot-runtime-api.js";
import type { ClawdbotConfig } from "./bot-runtime-api.js";

export function resolveFeishuReasoningPreviewEnabled(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  sessionKey?: string;
}): boolean {
  const configDefault = resolveFeishuConfigReasoningDefault(params.cfg, params.agentId);

  if (!params.sessionKey) {
    return configDefault === "stream";
  }

  try {
    const agentId = resolveAgentIdFromSessionKey(params.sessionKey);
    if (!agentId) {
      return configDefault === "stream";
    }
    const level = getSessionEntry({ agentId, sessionKey: params.sessionKey })?.reasoningLevel;
    if (level === "on" || level === "stream" || level === "off") {
      return level === "stream";
    }
  } catch {
    return configDefault === "stream";
  }
  return configDefault === "stream";
}
