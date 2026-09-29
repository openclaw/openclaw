import type { AgentCreateParams, AgentTextParam } from "openai/resources/beta/agents/agents";
import {
  resolveAliasedParamValue,
  resolveModelExtraParamSources,
} from "openclaw/plugin-sdk/agent-harness-attempt-runtime";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

export const SERVICE_TIER_KEYS = ["serviceTier", "service_tier"] as const;
export const TEXT_VERBOSITY_KEYS = ["text_verbosity", "textVerbosity"] as const;

export function resolveAgentsApiModelParams(
  params: Parameters<typeof resolveModelExtraParamSources>[0],
) {
  const { defaultParams, modelParams, agentModelParams, agentParams } =
    resolveModelExtraParamSources(params);
  const sources = [defaultParams, modelParams, agentModelParams, agentParams];
  return {
    serviceTier: resolveOption(
      resolveAliasedParamValue(sources, SERVICE_TIER_KEYS),
      ["auto", "default", "flex", "priority", "fast"] as const satisfies ReadonlyArray<
        AgentCreateParams["service_tier"]
      >,
      "service tier",
    ),
    textVerbosity: resolveOption(
      resolveAliasedParamValue(sources, TEXT_VERBOSITY_KEYS),
      ["low", "medium", "high"] as const satisfies ReadonlyArray<AgentTextParam["verbosity"]>,
      "text verbosity",
    ),
  };
}

function resolveOption<T extends string>(
  raw: unknown,
  supported: readonly T[],
  label: string,
): T | undefined {
  const normalized = normalizeOptionalLowercaseString(raw);
  const value = supported.find((candidate) => candidate === normalized);
  if (raw != null && value === undefined) {
    embeddedAgentLog.warn(`Ignoring invalid Agents API ${label}; expected ${supported.join(", ")}`);
  }
  return value;
}
