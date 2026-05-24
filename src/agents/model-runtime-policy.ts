import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { listAgentEntries, resolveSessionAgentIds } from "./agent-scope.js";
import { normalizeProviderId } from "./provider-id.js";

export type ModelRuntimePolicySource = "model" | "provider";

export type ResolvedModelRuntimePolicy = {
  policy?: AgentRuntimePolicyConfig;
  source?: ModelRuntimePolicySource;
  /**
   * Provider id from the matched entry key (e.g. "anthropic" for an
   * `anthropic/foo` agent model entry). Lets downstream resolvers validate
   * provider/runtime pairings when the caller passed an empty provider.
   */
  matchedProvider?: string;
};

type ModelEntryMatchKind = "none" | "exact" | "provider-wildcard";

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

function normalizeModelIdForProvider(
  provider: string | undefined,
  modelId: string | undefined,
): string | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return trimmed;
  }
  const modelProvider = normalizeProviderId(trimmed.slice(0, slash));
  const expectedProvider = normalizeProviderId(provider ?? "");
  if (expectedProvider && modelProvider !== expectedProvider) {
    return undefined;
  }
  return trimmed.slice(slash + 1).trim() || undefined;
}

function modelEntryMatches(params: {
  entry: Pick<ModelDefinitionConfig, "id">;
  provider: string | undefined;
  modelId: string;
}): boolean {
  return modelEntryMatchKind(params) === "exact";
}

function modelEntryMatchKind(params: {
  entry: Pick<ModelDefinitionConfig, "id">;
  provider: string | undefined;
  modelId: string;
}): ModelEntryMatchKind {
  const entryId = params.entry.id.trim();
  if (entryId === params.modelId) {
    return "exact";
  }
  const slash = entryId.indexOf("/");
  if (slash <= 0) {
    return "none";
  }
  // Empty/undefined caller provider means "no provider constraint"; the entry's
  // slash-prefix is itself authoritative. Distinguishes the bare-model session
  // case (saved before provider-prefix normalization) from a real mismatch.
  const callerProvider = normalizeProviderId(params.provider ?? "");
  const entryProvider = normalizeProviderId(entryId.slice(0, slash));
  if (callerProvider && callerProvider !== entryProvider) {
    return "none";
  }
  const entryModelId = entryId.slice(slash + 1).trim();
  if (entryModelId === params.modelId) {
    return "exact";
  }
  if (entryModelId === "*") {
    return "provider-wildcard";
  }
  return "none";
}

function modelKeyMatchKind(params: {
  key: string;
  provider: string | undefined;
  modelId: string;
}): ModelEntryMatchKind {
  return modelEntryMatchKind({
    entry: { id: params.key },
    provider: params.provider,
    modelId: params.modelId,
  });
}

function modelKeyIsProviderWildcard(params: {
  key: string;
  provider: string | undefined;
}): boolean {
  const slash = params.key.indexOf("/");
  if (slash <= 0) {
    return false;
  }
  const callerProvider = normalizeProviderId(params.provider ?? "");
  const entryProvider = normalizeProviderId(params.key.slice(0, slash));
  if (callerProvider && callerProvider !== entryProvider) {
    return false;
  }
  return params.key.slice(slash + 1).trim() === "*";
}

function resolveAgentModelEntryRuntimePolicy(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
  matchKind: Exclude<ModelEntryMatchKind, "none">;
}): ResolvedModelRuntimePolicy {
  const modelId = normalizeModelIdForProvider(params.provider, params.modelId);
  if (!params.config || (!modelId && params.matchKind !== "provider-wildcard")) {
    return {};
  }
  const { sessionAgentId } = resolveSessionAgentIds({
    config: params.config,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const agentEntry = listAgentEntries(params.config).find(
    (entry) => normalizeAgentId(entry.id) === sessionAgentId,
  );
  const modelMaps: Array<Record<string, AgentModelEntryConfig> | undefined> = [
    agentEntry?.models,
    params.config.agents?.defaults?.models,
  ];
  const callerProvider = normalizeProviderId(params.provider ?? "");
  // Walk model maps in precedence order (agent-specific before defaults) and
  // resolve within the first scope that has any matches. When the caller
  // provider is empty, multiple provider-prefixed entries in the SAME scope
  // (e.g. defaults has both "openai/gpt-5" and "azure/gpt-5") are ambiguous and
  // return {}; a lower-precedence scope must not introduce ambiguity that
  // overrides a clean higher-precedence match.
  for (const models of modelMaps) {
    const scopeMatches: Array<{ provider: string; policy: AgentRuntimePolicyConfig }> = [];
    for (const [key, entry] of Object.entries(models ?? {})) {
      const matches = modelId
        ? modelKeyMatchKind({ key, provider: params.provider, modelId }) === params.matchKind
        : modelKeyIsProviderWildcard({ key, provider: params.provider });
      const policy = entry?.agentRuntime;
      if (!matches || !policy || !hasRuntimePolicy(policy)) {
        continue;
      }
      const slash = key.indexOf("/");
      const entryProvider = slash > 0 ? normalizeProviderId(key.slice(0, slash)) : "";
      scopeMatches.push({ provider: entryProvider, policy });
    }
    if (scopeMatches.length === 0) {
      continue;
    }
    if (callerProvider) {
      return {
        policy: scopeMatches[0].policy,
        source: "model",
        matchedProvider: scopeMatches[0].provider || callerProvider,
      };
    }
    const distinctProviders = new Set(scopeMatches.map((m) => m.provider));
    if (distinctProviders.size > 1) {
      return {};
    }
    return {
      policy: scopeMatches[0].policy,
      source: "model",
      matchedProvider: scopeMatches[0].provider,
    };
  }
  return {};
}

function resolveModelConfig(params: {
  providerConfig?: ModelProviderConfig;
  provider?: string;
  modelId?: string;
}): ModelDefinitionConfig | undefined {
  const modelId = normalizeModelIdForProvider(params.provider, params.modelId);
  if (!modelId || !Array.isArray(params.providerConfig?.models)) {
    return undefined;
  }
  return params.providerConfig.models.find((entry) =>
    modelEntryMatches({ entry, provider: params.provider, modelId }),
  );
}

export function resolveModelRuntimePolicy(params: {
  config?: OpenClawConfig;
  provider?: string;
  modelId?: string;
  agentId?: string;
  sessionKey?: string;
}): ResolvedModelRuntimePolicy {
  if (process.env.OPENCLAW_BUILD_PRIVATE_QA === "1") {
    const forcedRuntime = process.env.OPENCLAW_QA_FORCE_RUNTIME?.trim().toLowerCase();
    if (forcedRuntime === "pi" || forcedRuntime === "codex") {
      return { policy: { id: forcedRuntime }, source: "model" };
    }
  }

  const agentModelPolicy = resolveAgentModelEntryRuntimePolicy({ ...params, matchKind: "exact" });
  if (agentModelPolicy.policy) {
    return agentModelPolicy;
  }
  const providerConfig = resolveProviderConfig(params.config, params.provider);
  const modelConfig = resolveModelConfig({
    providerConfig,
    provider: params.provider,
    modelId: params.modelId,
  });
  if (hasRuntimePolicy(modelConfig?.agentRuntime)) {
    return { policy: modelConfig?.agentRuntime, source: "model" };
  }
  const agentWildcardModelPolicy = resolveAgentModelEntryRuntimePolicy({
    ...params,
    matchKind: "provider-wildcard",
  });
  if (agentWildcardModelPolicy.policy) {
    return agentWildcardModelPolicy;
  }
  if (hasRuntimePolicy(providerConfig?.agentRuntime)) {
    return { policy: providerConfig?.agentRuntime, source: "provider" };
  }
  return {};
}
