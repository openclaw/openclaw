import { resolveHeartbeatPrompt as resolveHeartbeatPromptText } from "../auto-reply/heartbeat.js";
import type { OpenClawConfig } from "../config/config.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope.js";

type HeartbeatConfig = AgentDefaultsConfig["heartbeat"];

function resolveHeartbeatConfigForSystemPrompt(
  config?: OpenClawConfig,
  agentId?: string,
): HeartbeatConfig | undefined {
  const defaults = config?.agents?.defaults?.heartbeat;
  if (!config || !agentId) {
    return defaults;
  }
  const overrides = resolveAgentConfig(config, agentId)?.heartbeat;
  if (!defaults && !overrides) {
    return overrides;
  }
  return { ...defaults, ...overrides };
}

export function resolveHeartbeatPromptForSystemPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  defaultAgentId?: string;
}): string | undefined {
  const defaultAgentId = params.defaultAgentId ?? resolveDefaultAgentId(params.config ?? {});
  const agentId = params.agentId ?? defaultAgentId;
  if (!agentId || agentId !== defaultAgentId) {
    return undefined;
  }
  const heartbeat = resolveHeartbeatConfigForSystemPrompt(params.config, agentId);
  if (heartbeat?.includeSystemPromptSection === false) {
    return undefined;
  }
  return resolveHeartbeatPromptText(heartbeat?.prompt);
}
