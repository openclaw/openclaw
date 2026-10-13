import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import { getSessionEntryAsync } from "openclaw/plugin-sdk/session-store-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";

export async function resolveFeishuReasoningPreviewEnabled(params: {
  cfg: ClawdbotConfig;
  agentId: string;
  storePath: string;
  sessionKey?: string;
}): Promise<boolean> {
  const configDefault =
    resolveAgentConfig(params.cfg, params.agentId)?.reasoningDefault ??
    params.cfg.agents?.defaults?.reasoningDefault ??
    "off";

  if (!params.sessionKey) {
    return configDefault === "stream";
  }

  try {
    const level = (
      await getSessionEntryAsync({
        storePath: params.storePath,
        sessionKey: params.sessionKey,
        readConsistency: "latest",
      })
    )?.reasoningLevel;
    if (level === "on" || level === "stream" || level === "off") {
      return level === "stream";
    }
  } catch {
    return false;
  }
  return configDefault === "stream";
}
