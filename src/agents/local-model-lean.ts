import type { LocalModelLeanSetting } from "../config/types.agent-defaults.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveAgentConfig, resolveDefaultAgentId } from "./agent-scope-config.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

const LOCAL_MODEL_LEAN_DENY_TOOL_NAMES = new Set(["browser", "cron", "message"]);
const LOCAL_MODEL_LEAN_AUTO_CONTEXT_TOKENS = 65_536;

function normalizePositiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : undefined;
}

function smallestPositiveInteger(...values: Array<number | undefined>): number | undefined {
  const normalizedValues = values
    .map((value) => normalizePositiveInteger(value))
    .filter((value): value is number => value !== undefined);
  return normalizedValues.length > 0 ? Math.min(...normalizedValues) : undefined;
}

function resolveLocalModelLeanAgentId(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): string | undefined {
  const explicitAgentId =
    typeof params.agentId === "string" && params.agentId.trim()
      ? normalizeAgentId(params.agentId)
      : undefined;
  if (explicitAgentId) {
    return explicitAgentId;
  }
  const parsedSessionAgentId = parseAgentSessionKey(params.sessionKey)?.agentId;
  if (parsedSessionAgentId) {
    return normalizeAgentId(parsedSessionAgentId);
  }
  return params.config ? resolveDefaultAgentId(params.config) : undefined;
}

export function isLocalModelLeanEnabled(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  modelContextTokens?: number;
  modelContextWindowTokens?: number;
}): boolean {
  const setting = resolveLocalModelLeanSetting(params);
  if (setting === true) {
    return true;
  }
  if (setting !== "auto") {
    return false;
  }
  const modelContextTokens = smallestPositiveInteger(
    params.modelContextTokens,
    params.modelContextWindowTokens,
  );
  return (
    modelContextTokens !== undefined && modelContextTokens <= LOCAL_MODEL_LEAN_AUTO_CONTEXT_TOKENS
  );
}

function resolveLocalModelLeanSetting(params: {
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
}): LocalModelLeanSetting | undefined {
  const normalizedAgentId = resolveLocalModelLeanAgentId(params);
  const resolvedExperimental =
    params.config && normalizedAgentId
      ? (resolveAgentConfig(params.config, normalizedAgentId)?.experimental ??
        params.config.agents?.defaults?.experimental)
      : params.config?.agents?.defaults?.experimental;
  return resolvedExperimental?.localModelLean;
}

export function filterLocalModelLeanTools(params: {
  tools: AnyAgentTool[];
  config?: OpenClawConfig;
  agentId?: string;
  sessionKey?: string;
  modelContextTokens?: number;
  modelContextWindowTokens?: number;
}): AnyAgentTool[] {
  if (!isLocalModelLeanEnabled(params)) {
    return params.tools;
  }
  return params.tools.filter((tool) => !LOCAL_MODEL_LEAN_DENY_TOOL_NAMES.has(tool.name));
}
