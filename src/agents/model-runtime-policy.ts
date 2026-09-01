/**
 * Model runtime policy resolution.
 *
 * Agent execution uses this to choose a model/provider-specific runtime policy
 * from agent entries, model catalog config, provider config, or QA overrides.
 */
import { parseModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentEntries, resolveSessionAgentIds } from "./agent-scope.js";

/** Config surface that supplied a resolved model runtime policy. */
type ModelRuntimePolicySource = "model" | "provider";

/** Runtime policy plus the config surface that supplied it. */
type ResolvedModelRuntimePolicy = {
  policy?: AgentRuntimePolicyConfig;
  source?: ModelRuntimePolicySource;
  matchedProvider?: string;
  forcedByEnvironment?: true;
};

type ModelEntryMatchKind = "none" | "exact" | "provider-wildcard";

type AgentModelRuntimePolicyMatch = {
  provider: string;
  policy: AgentRuntimePolicyConfig;
};

type AgentModelRuntimePolicyResolution = ResolvedModelRuntimePolicy & {
  ambiguous?: true;
};

function hasRuntimePolicy(value: AgentRuntimePolicyConfig | undefined): boolean {
  return Boolean(value?.id?.trim());
}

function resolveProviderConfig(
  config: OpenClawConfig | undefined,
  provider: string | undefined,
): ModelProviderConfig | undefined {
  if (!config?.models?.providers || !provider?.trim()) {
    return undefined;
  }
  const providers = config.models.providers;
  const direct = providers[provider];
  if (direct) {
    return direct;
  }
  const normalizedProvider = normalizeProviderId(provider);
  for (const [candidateProvider, providerConfig] of Object.entries(providers)) {
    if (normalizeProviderId(candidateProvider) === normalizedProvider) {
      return providerConfig;
    }
  }
  return undefined;
}

function resolvePolicyMatch(
  matches: AgentModelRuntimePolicyMatch[],
  callerProvider: string,
): AgentModelRuntimePolicyResolution {
  const providerMatches = callerProvider
    ? matches.filter((match) => match.provider === callerProvider)
    : [];
  const candidates = providerMatches.length > 0 ? providerMatches : matches;
  const [first] = candidates;
  if (!first) {
    return {};
  }
  if (!callerProvider && candidates.some((match) => match.provider !== first.provider)) {
    return { ambiguous: true };
  }
  return {
    policy: first.policy,
    source: "model",
    matchedProvider: first.provider || callerProvider,
  };
}

function agentModelEntryMatchKind(params: {
  key: string;
  provider: string | undefined;
  modelId: string;
}): ModelEntryMatchKind {
  const key = params.key.trim();
  const parsed = parseModelCatalogRef(key);
  if (!parsed) {
    return key === params.modelId ? "exact" : "none";
  }
  const callerProvider = normalizeProviderId(params.provider ?? "");
  if (callerProvider && parsed.provider !== callerProvider) {
    return "none";
  }
  if (parsed.modelId === params.modelId) {
    return "exact";
  }
  if (parsed.modelId === "*") {
    return "provider-wildcard";
  }
  return "none";
}

function resolveAgentModelEntryRuntimePolicy(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
  matchKind: Exclude<ModelEntryMatchKind, "none">;
}): AgentModelRuntimePolicyResolution {
  const modelId = params.modelId;
  if (!params.config || (!modelId && params.matchKind !== "provider-wildcard")) {
    return {};
  }
  const hasSessionScope = Boolean(params.agentId?.trim() || params.sessionKey?.trim());
  const sessionAgentId = hasSessionScope
    ? resolveSessionAgentIds({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      }).sessionAgentId
    : tryResolveLegacyCompatibilityAgentId(params.config);
  const agentEntry = sessionAgentId
    ? listAgentEntries(params.config).find((entry) => normalizeAgentId(entry.id) === sessionAgentId)
    : undefined;
  const modelMaps: Array<Record<string, AgentModelEntryConfig> | undefined> = [
    agentEntry?.models,
    params.config.agents?.defaults?.models,
  ];
  const callerProvider = normalizeProviderId(params.provider ?? "");
  for (const models of modelMaps) {
    const scopeMatches: AgentModelRuntimePolicyMatch[] = [];
    for (const [key, entry] of Object.entries(models ?? {})) {
      const matches =
        agentModelEntryMatchKind({
          key,
          provider: params.provider,
          modelId: modelId ?? "",
        }) === params.matchKind;
      const policy = entry?.agentRuntime;
      if (!matches || !policy || !hasRuntimePolicy(policy)) {
        continue;
      }
      scopeMatches.push({ provider: parseModelCatalogRef(key)?.provider ?? "", policy });
    }
    // Unqualified model ids can match multiple provider-qualified entries; avoid
    // choosing an arbitrary runtime when the provider is unknown.
    const resolved = resolvePolicyMatch(scopeMatches, callerProvider);
    if (resolved.policy || resolved.ambiguous) {
      return resolved;
    }
  }
  return {};
}

function resolveModelConfig(params: {
  providerConfig?: ModelProviderConfig;
  modelId?: string;
}): ModelDefinitionConfig | undefined {
  const modelId = params.modelId;
  if (!modelId || !Array.isArray(params.providerConfig?.models)) {
    return undefined;
  }
  return params.providerConfig.models.find((entry) => entry.id.trim() === modelId);
}

/** Resolves the effective runtime policy for an agent/model/provider selection. */
export function resolveModelRuntimePolicy(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
}): ResolvedModelRuntimePolicy {
  const callerProvider = normalizeProviderId(params.provider ?? "");
  // An explicit provider makes modelId provider-local, even when it contains
  // that provider's name. Only providerless input is a raw combined ref.
  const inferredRef = callerProvider ? null : parseModelCatalogRef(params.modelId?.trim() ?? "");
  const effectiveProvider = callerProvider || inferredRef?.provider;
  const modelId = inferredRef?.modelId ?? params.modelId?.trim();
  const inferredMatchedProvider = callerProvider ? undefined : effectiveProvider;
  if (process.env.OPENCLAW_BUILD_PRIVATE_QA === "1") {
    const forcedRuntime = process.env.OPENCLAW_QA_FORCE_RUNTIME?.trim().toLowerCase();
    if (forcedRuntime === "openclaw" || forcedRuntime === "codex") {
      return { policy: { id: forcedRuntime }, source: "model", forcedByEnvironment: true };
    }
  }

  const agentModelPolicy = resolveAgentModelEntryRuntimePolicy({
    ...params,
    provider: effectiveProvider,
    modelId,
    matchKind: "exact",
  });
  if (agentModelPolicy.ambiguous) {
    return {};
  }
  if (agentModelPolicy.policy) {
    return agentModelPolicy;
  }
  const providerConfig = resolveProviderConfig(params.config, effectiveProvider);
  const modelConfig = resolveModelConfig({
    providerConfig,
    modelId,
  });
  if (hasRuntimePolicy(modelConfig?.agentRuntime)) {
    return {
      policy: modelConfig?.agentRuntime,
      source: "model",
      ...(inferredMatchedProvider ? { matchedProvider: inferredMatchedProvider } : {}),
    };
  }
  const agentWildcardModelPolicy = resolveAgentModelEntryRuntimePolicy({
    ...params,
    provider: effectiveProvider,
    modelId,
    matchKind: "provider-wildcard",
  });
  if (agentWildcardModelPolicy.policy) {
    return agentWildcardModelPolicy;
  }
  if (hasRuntimePolicy(providerConfig?.agentRuntime)) {
    return {
      policy: providerConfig?.agentRuntime,
      source: "provider",
      ...(inferredMatchedProvider ? { matchedProvider: inferredMatchedProvider } : {}),
    };
  }
  return {};
}
