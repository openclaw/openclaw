import {
  DEFAULT_HEARTBEAT_EVERY,
  resolveHeartbeatPrompt as resolveHeartbeatPromptText,
} from "../auto-reply/heartbeat.js";
import { parseDurationMs } from "../cli/parse-duration.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isHeartbeatEnabledForAgent } from "../infra/heartbeat-summary.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
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

function isHeartbeatCadenceEnabled(heartbeat?: HeartbeatConfig): boolean {
  const rawEvery = heartbeat?.every ?? DEFAULT_HEARTBEAT_EVERY;
  const trimmedEvery = normalizeOptionalString(rawEvery) ?? "";
  if (!trimmedEvery) {
    return false;
  }
  try {
    return parseDurationMs(trimmedEvery, { defaultUnit: "m" }) > 0;
  } catch {
    return false;
  }
}

export function shouldIncludeHeartbeatGuidanceForSystemPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  defaultAgentId?: string;
}): boolean {
  const defaultAgentId = params.defaultAgentId ?? resolveDefaultAgentId(params.config ?? {});
  const agentId = params.agentId ?? defaultAgentId;
  if (!agentId || normalizeAgentId(agentId) !== normalizeAgentId(defaultAgentId)) {
    return false;
  }
  if (params.config && !isHeartbeatEnabledForAgent(params.config, agentId)) {
    return false;
  }
  const heartbeat = resolveHeartbeatConfigForSystemPrompt(params.config, agentId);
  if (heartbeat?.includeSystemPromptSection === false) {
    return false;
  }
  return isHeartbeatCadenceEnabled(heartbeat);
}

export function resolveHeartbeatPromptForSystemPrompt(params: {
  config?: OpenClawConfig;
  agentId?: string;
  defaultAgentId?: string;
}): string | undefined {
  const agentId =
    params.agentId ?? params.defaultAgentId ?? resolveDefaultAgentId(params.config ?? {});
  const heartbeat = resolveHeartbeatConfigForSystemPrompt(params.config, agentId);
  if (!shouldIncludeHeartbeatGuidanceForSystemPrompt(params)) {
    return undefined;
  }
  return resolveHeartbeatPromptText(heartbeat?.prompt);
}
