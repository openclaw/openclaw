import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

export function resolveTelegramConfigReasoningDefault(cfg: OpenClawConfig, agentId: string) {
  const agentDefault = resolveAgentConfig(cfg, agentId)?.reasoningDefault;
  return agentDefault ?? cfg.agents?.defaults?.reasoningDefault ?? "off";
}
