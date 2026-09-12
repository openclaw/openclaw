/**
 * Model runtime policy resolution.
 *
 * Agent execution uses this to choose a model/provider-specific runtime policy
 * from agent entries, model catalog config, provider config, or QA overrides.
 */
import {
  parseModelCatalogRef,
  type ProviderModelRef,
} from "@openclaw/model-catalog-core/model-catalog-refs";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolveAgentModelPrimaryValue } from "../config/model-input.js";
import { resolveMergedModelProviderConfig } from "../config/model-provider-config.js";
import type { AgentModelEntryConfig } from "../config/types.agent-defaults.js";
import type { AgentRuntimePolicyConfig } from "../config/types.agents-shared.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderResolveModelRoutesContext } from "../plugin-sdk/provider-model-types.js";
import { isDefaultAgentRuntimeId, normalizeOptionalAgentRuntimeId } from "./agent-runtime-id.js";
import { resolveAgentEntry } from "./agent-scope-config.js";
import { resolveSessionAgentIds } from "./agent-scope.js";
import { splitTrailingAuthProfile } from "./model-ref-profile.js";
import { resolveProviderModelRouteAuthRequirement } from "./provider-model-route-auth.js";

/** A stored-row owner is already selected; request hints still require normal admission. */
export type AgentRuntimePolicyScope = { sessionKey?: string } & (
  | { agentId?: string; agentScope?: never }
  | { agentId?: never; agentScope: { kind: "prepared"; agentId: string } }
);

/** Resolve request hints; prepared owner facts never re-admit a canonical sentinel. */
export function resolveAgentRuntimePolicyAgentId(
  params: AgentRuntimePolicyScope & { config?: OpenClawConfig },
): string | undefined {
  if (params.agentScope?.kind === "prepared") {
    return params.agentScope.agentId;
  }
  return params.config && (params.agentId?.trim() || params.sessionKey?.trim())
    ? resolveSessionAgentIds({
        config: params.config,
        agentId: params.agentId,
        sessionKey: params.sessionKey,
      }).sessionAgentId
    : params.agentId;
}

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
    // Provider-owned model ids may contain a different provider's name. Only
    // remove a model-ref prefix when it belongs to the selected provider.
    return trimmed;
  }
  return trimmed.slice(slash + 1).trim() || undefined;
}

function resolveEffectiveProvider(
  provider: string | undefined,
  modelId: string | undefined,
): string | undefined {
  const normalizedProvider = normalizeProviderId(provider ?? "");
  if (normalizedProvider) {
    return normalizedProvider;
  }
  return parseModelCatalogRef(modelId?.trim() ?? "")?.provider;
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

function modelEntryMatchKind(params: {
  entry: Pick<ModelDefinitionConfig, "id">;
  provider: string | undefined;
  modelId: string;
}): ModelEntryMatchKind {
  const entryId = params.entry.id.trim();
  if (entryId === params.modelId) {
    return "exact";
  }
  const parsed = parseModelCatalogRef(entryId);
  if (!parsed) {
    return "none";
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
  matchKind: Exclude<ModelEntryMatchKind, "none">;
}): AgentModelRuntimePolicyResolution {
  const modelId = normalizeModelIdForProvider(params.provider, params.modelId);
  if (!params.config || (!modelId && params.matchKind !== "provider-wildcard")) {
    return {};
  }
  // Point lookup: projecting the whole roster per model ref made runtime
  // collection O(agents² × models) on large fleets (#135743).
  const agentEntry = params.agentId ? resolveAgentEntry(params.config, params.agentId) : undefined;
  const modelMaps: Array<Record<string, AgentModelEntryConfig> | undefined> = [
    agentEntry?.models,
    params.config.agents?.defaults?.models,
  ];
  const callerProvider = normalizeProviderId(params.provider ?? "");
  for (const models of modelMaps) {
    const scopeMatches: AgentModelRuntimePolicyMatch[] = [];
    for (const [key, entry] of Object.entries(models ?? {})) {
      const matches =
        modelEntryMatchKind({
          entry: { id: key },
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
  provider?: string;
  modelId?: string;
}): ModelDefinitionConfig | undefined {
  const modelId = normalizeModelIdForProvider(params.provider, params.modelId);
  if (!modelId || !Array.isArray(params.providerConfig?.models)) {
    return undefined;
  }
  return params.providerConfig.models.find(
    (entry) => modelEntryMatchKind({ entry, provider: params.provider, modelId }) === "exact",
  );
}

/** Resolves the effective runtime policy for an agent/model/provider selection. */
export function resolveModelRuntimePolicy(
  params: {
    config?: OpenClawConfig;
    provider?: string;
    modelId?: string;
  } & AgentRuntimePolicyScope,
): ResolvedModelRuntimePolicy {
  const callerProvider = normalizeProviderId(params.provider ?? "");
  const effectiveProvider = resolveEffectiveProvider(params.provider, params.modelId);
  const inferredMatchedProvider = callerProvider ? undefined : effectiveProvider;
  if (process.env.OPENCLAW_BUILD_PRIVATE_QA === "1") {
    const forcedRuntime = process.env.OPENCLAW_QA_FORCE_RUNTIME?.trim().toLowerCase();
    if (forcedRuntime === "openclaw" || forcedRuntime === "codex") {
      return { policy: { id: forcedRuntime }, source: "model", forcedByEnvironment: true };
    }
  }

  const hasAgentScope = Boolean(
    params.agentScope || params.agentId?.trim() || params.sessionKey?.trim(),
  );
  const agentId = hasAgentScope
    ? resolveAgentRuntimePolicyAgentId(params)
    : params.config && tryResolveLegacyCompatibilityAgentId(params.config);
  const agentModelPolicy = resolveAgentModelEntryRuntimePolicy({
    ...params,
    agentId,
    provider: effectiveProvider,
    matchKind: "exact",
  });
  if (agentModelPolicy.ambiguous) {
    return {};
  }
  if (agentModelPolicy.policy) {
    return agentModelPolicy;
  }
  const providerConfig = effectiveProvider
    ? resolveMergedModelProviderConfig(params.config, effectiveProvider)
    : undefined;
  const modelConfig = resolveModelConfig({
    providerConfig,
    provider: effectiveProvider,
    modelId: params.modelId,
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
    agentId,
    provider: effectiveProvider,
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

/** Projects authored routing intent without changing harness compatibility or selection. */
export function resolveModelRouteIntent(
  params: Parameters<typeof resolveModelRuntimePolicy>[0] & {
    runtimePolicy?: ReturnType<typeof resolveModelRuntimePolicy>;
    primaryModel?: ProviderModelRef;
    resolveProfileAuthMode?: (profileId: string) => string | undefined;
  },
): ProviderResolveModelRoutesContext["routeIntent"] {
  const selected = splitTrailingAuthProfile(params.modelId ?? "");
  const configured =
    params.runtimePolicy ?? resolveModelRuntimePolicy({ ...params, modelId: selected.model });
  const runtimeId = normalizeOptionalAgentRuntimeId(configured.policy?.id);
  const selectedRequirement = resolveProviderModelRouteAuthRequirement(
    selected.profile
      ? (params.config?.auth?.profiles?.[selected.profile]?.mode ??
          params.resolveProfileAuthMode?.(selected.profile))
      : undefined,
  );
  if (selectedRequirement) {
    return {
      ...(runtimeId && !isDefaultAgentRuntimeId(runtimeId) ? { runtimeId } : {}),
      authRequirement: selectedRequirement,
      source: "explicit",
    };
  }
  if (runtimeId && !isDefaultAgentRuntimeId(runtimeId)) {
    return { runtimeId, source: "explicit" };
  }
  if (!params.config) {
    return undefined;
  }
  const agentId = resolveAgentRuntimePolicyAgentId(params);
  const agentEntry = agentId ? resolveAgentEntry(params.config, agentId) : undefined;
  const primary =
    resolveAgentModelPrimaryValue(agentEntry?.model) ??
    resolveAgentModelPrimaryValue(params.config.agents?.defaults?.model);
  const primarySelection = primary ? splitTrailingAuthProfile(primary) : undefined;
  const primaryRef = params.primaryModel
    ? {
        provider: params.primaryModel.provider,
        modelId: splitTrailingAuthProfile(params.primaryModel.model).model,
      }
    : primarySelection
      ? parseModelCatalogRef(primarySelection.model)
      : null;
  if (
    !primaryRef ||
    primaryRef.provider !== resolveEffectiveProvider(params.provider, params.modelId)
  ) {
    return undefined;
  }
  const inheritedPolicy = resolveModelRuntimePolicy({
    ...params,
    provider: primaryRef.provider,
    modelId: primaryRef.modelId,
  });
  const inheritedRuntimeId = normalizeOptionalAgentRuntimeId(inheritedPolicy.policy?.id);
  const primaryRequirement = resolveProviderModelRouteAuthRequirement(
    primarySelection?.profile
      ? (params.config.auth?.profiles?.[primarySelection.profile]?.mode ??
          params.resolveProfileAuthMode?.(primarySelection.profile))
      : undefined,
  );
  if (primaryRequirement) {
    return {
      ...(inheritedRuntimeId && !isDefaultAgentRuntimeId(inheritedRuntimeId)
        ? { runtimeId: inheritedRuntimeId }
        : {}),
      authRequirement: primaryRequirement,
      source: "inherited",
    };
  }
  return inheritedRuntimeId && !isDefaultAgentRuntimeId(inheritedRuntimeId)
    ? { runtimeId: inheritedRuntimeId, source: "inherited" }
    : undefined;
}
