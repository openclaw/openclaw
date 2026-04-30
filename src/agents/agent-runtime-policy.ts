import type {
  AgentEmbeddedHarnessConfig,
  AgentRuntimePolicyConfig,
} from "../config/types.agents-shared.js";

type AgentRuntimePolicyContainer = {
  agentRuntime?: AgentRuntimePolicyConfig;
  embeddedHarness?: AgentEmbeddedHarnessConfig;
};

export function resolveAgentRuntimePolicy(
  container: AgentRuntimePolicyContainer | undefined,
): AgentRuntimePolicyConfig | undefined {
  const preferred = container?.agentRuntime;
  const legacy = normalizeLegacyEmbeddedHarnessPolicy(container?.embeddedHarness);
  if (hasAgentRuntimePolicy(preferred)) {
    return mergeRuntimePolicy(preferred, legacy);
  }
  return legacy;
}

function hasAgentRuntimePolicy(
  value: AgentRuntimePolicyConfig | undefined,
): value is AgentRuntimePolicyConfig {
  return Boolean(value?.id?.trim() || value?.fallback);
}

function normalizeLegacyEmbeddedHarnessPolicy(
  value: AgentEmbeddedHarnessConfig | undefined,
): AgentRuntimePolicyConfig | undefined {
  const next: AgentRuntimePolicyConfig = {};
  if (value?.runtime !== undefined) {
    next.id = value.runtime;
  }
  if (value?.fallback !== undefined) {
    next.fallback = value.fallback;
  }
  return hasAgentRuntimePolicy(next) ? next : undefined;
}

function mergeRuntimePolicy(
  preferred: AgentRuntimePolicyConfig,
  legacy: AgentRuntimePolicyConfig | undefined,
): AgentRuntimePolicyConfig {
  if (!legacy) {
    return preferred;
  }
  return {
    ...legacy,
    ...preferred,
    id: preferred.id ?? legacy.id,
    fallback: preferred.fallback ?? legacy.fallback,
  };
}
