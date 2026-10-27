import {
  normalizeOptionalString,
  resolvePrimaryStringValue,
} from "@openclaw/normalization-core/string-coerce";
import {
  resolveAgentModelFallbackValues,
  resolveSelectedModelFallbacksOverride,
} from "../config/model-input.js";
import {
  resolveCollapsedSessionAuthPinSource,
  resolveSessionAuthProfileOverrideSource,
} from "../config/sessions/auth-profile-override-provenance.js";
import { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { AgentDefaultsConfig } from "../config/types.agent-defaults.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { AgentConfig } from "../config/types.agents.js";
import type { OpenClawConfig } from "../config/types.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { isPathInside } from "../infra/path-guards.js";
import { isSubagentSessionKey, normalizeAgentId } from "../routing/session-key.js";
import {
  hasAgentRosterProperty,
  listAgentIds,
  resolveMutableAgentEntry,
  resolveAgentConfig,
  resolveAgentModelConfigForRuntime,
  resolveAgentWorkspaceDir,
  resolveSessionAgentIds,
  withAgentRosterFactsBatch,
} from "./agent-scope-config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import type { ModelRef } from "./model-ref-shared.js";
import { resolveConfiguredModelRef } from "./model-selection-shared.js";
import { resolveCanonicalWorkspacePath } from "./workspace-state-identity.js";
export { hasSessionAutoModelFallbackProvenance } from "../config/sessions/model-override-provenance.js";
export { resolveEffectiveAgentSkillFilter as resolveAgentSkillsFilter } from "../skills/discovery/agent-filter.js";
export {
  listAgentEntries,
  listAgentEntriesWithSource,
  listAgentIds,
  resolveConfiguredAgentId,
  resolveMutableAgentEntry,
  toAgentEntriesRecord,
  resolveAgentConfig,
  resolveAgentContextLimits,
  resolveAgentVerboseDefault,
  resolveAgentNativeModelPrimary,
  resolveNativeModelPrimary,
  resolveAgentDir,
  resolveDefaultAgentDir,
  resolveAgentRunCwd,
  resolveAgentWorkspaceDir,
  resolveAgentWorkspaceProvisioning,
  tryResolveConfiguredAgentWorkspaceDir,
  resolveDefaultAgentId,
  resolveAmbientOwnerAgentId,
  resolveSoleAgentId,
  tryResolveAmbientOwnerAgentId,
  tryResolveLegacyCompatibilityAgentId,
  tryResolveSoleAgentId,
  tryResolveDefaultAgentId,
  AgentSelectionRequiredError,
  resolveSessionAgentId,
  resolveSessionAgentIdStrict,
  resolveSessionAgentIds,
  resolveSessionAgentIdsStrict,
} from "./agent-scope-config.js";

const AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS = 5 * 60 * 1000;
const AUTO_FALLBACK_PRIMARY_PROBE_MAX_KEYS = 4096;
const autoFallbackPrimaryProbeState = new Map<string, number>();

function autoFallbackPrimaryProbeStateKey(params: {
  sessionKey?: string | null;
  primaryProvider: string;
  primaryModel: string;
}): string {
  return [
    normalizeOptionalString(params.sessionKey) ?? "",
    `${params.primaryProvider}/${params.primaryModel}`,
  ].join("\0");
}

function pruneAutoFallbackPrimaryProbeState(state: Map<string, number>, now: number): void {
  const staleBefore = now - AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS;
  for (const [key, lastProbeAt] of state) {
    if (lastProbeAt < staleBefore) {
      state.delete(key);
    }
  }
  pruneMapToMaxSize(state, AUTO_FALLBACK_PRIMARY_PROBE_MAX_KEYS);
}

export type AutoFallbackPrimaryProbe = {
  provider: string;
  model: string;
  fallbackProvider: string;
  fallbackModel: string;
  fallbackAuthProfileId?: string;
  fallbackAuthProfileIdSource?: "auto" | "user";
};

type AutoFallbackSessionEntry = Pick<
  SessionEntry,
  | "providerOverride"
  | "modelOverride"
  | "modelOverrideSource"
  | "modelOverrideFallbackOriginProvider"
  | "modelOverrideFallbackOriginModel"
>;

/** Detects old auto-fallback session entries that lack primary-origin metadata. */
export function hasLegacyAutoFallbackWithoutOrigin(
  entry:
    | Pick<
        AutoFallbackSessionEntry,
        | "modelOverrideSource"
        | "modelOverrideFallbackOriginProvider"
        | "modelOverrideFallbackOriginModel"
      >
    | null
    | undefined,
): boolean {
  return (
    entry?.modelOverrideSource === "auto" &&
    (!normalizeOptionalString(entry.modelOverrideFallbackOriginProvider) ||
      !normalizeOptionalString(entry.modelOverrideFallbackOriginModel))
  );
}

export function resolveAutoFallbackPrimaryProbe(params: {
  entry:
    | (AutoFallbackSessionEntry &
        Pick<
          SessionEntry,
          "authProfileOverride" | "authProfileOverrideSource" | "authProfileOverrideCompactionCount"
        >)
    | null
    | undefined;
  sessionKey?: string | null;
  primaryProvider: string;
  primaryModel: string;
  probeState?: Map<string, number>;
}): AutoFallbackPrimaryProbe | undefined {
  const entry = params.entry;
  if (!entry) {
    return undefined;
  }
  const recoveredAutoFallbackOverride =
    entry.modelOverrideSource === undefined && hasSessionAutoModelFallbackProvenance(entry);
  if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
    return undefined;
  }

  const originProvider = normalizeOptionalString(entry.modelOverrideFallbackOriginProvider);
  const originModel = normalizeOptionalString(entry.modelOverrideFallbackOriginModel);
  const overrideProvider = normalizeOptionalString(entry.providerOverride);
  const overrideModel = normalizeOptionalString(entry.modelOverride);
  const primaryProvider = normalizeOptionalString(params.primaryProvider);
  const primaryModel = normalizeOptionalString(params.primaryModel);
  if (!originProvider || !originModel || !overrideProvider || !overrideModel) {
    return undefined;
  }
  if (!primaryProvider || !primaryModel) {
    return undefined;
  }
  if (originProvider !== primaryProvider || originModel !== primaryModel) {
    return undefined;
  }
  if (overrideProvider === originProvider && overrideModel === originModel) {
    return undefined;
  }

  const now = Date.now();
  const state = params.probeState ?? autoFallbackPrimaryProbeState;
  pruneAutoFallbackPrimaryProbeState(state, now);
  const key = autoFallbackPrimaryProbeStateKey({
    sessionKey: params.sessionKey,
    primaryProvider: originProvider,
    primaryModel: originModel,
  });
  const lastProbeAt = state.get(key);
  if (lastProbeAt !== undefined && now - lastProbeAt < AUTO_FALLBACK_PRIMARY_PROBE_INTERVAL_MS) {
    return undefined;
  }
  const fallbackAuthProfileId = normalizeOptionalString(entry.authProfileOverride);
  const fallbackAuthProfileIdSource = resolveCollapsedSessionAuthPinSource(entry);
  return {
    provider: originProvider,
    model: originModel,
    fallbackProvider: overrideProvider,
    fallbackModel: overrideModel,
    ...(fallbackAuthProfileId
      ? {
          fallbackAuthProfileId,
          ...(fallbackAuthProfileIdSource ? { fallbackAuthProfileIdSource } : {}),
        }
      : {}),
  };
}

export function markAutoFallbackPrimaryProbe(params: {
  probe: AutoFallbackPrimaryProbe;
  sessionKey?: string | null;
}): void {
  const now = Date.now();
  const key = autoFallbackPrimaryProbeStateKey({
    sessionKey: params.sessionKey,
    primaryProvider: params.probe.provider,
    primaryModel: params.probe.model,
  });
  autoFallbackPrimaryProbeState.set(key, now);
  pruneAutoFallbackPrimaryProbeState(autoFallbackPrimaryProbeState, now);
}

export function entryMatchesAutoFallbackPrimaryProbe(
  entry: AutoFallbackSessionEntry | null | undefined,
  probe: AutoFallbackPrimaryProbe,
): boolean {
  if (!entry) {
    return false;
  }
  const recoveredAutoFallbackOverride =
    entry.modelOverrideSource === undefined && hasSessionAutoModelFallbackProvenance(entry);
  if (entry.modelOverrideSource !== "auto" && !recoveredAutoFallbackOverride) {
    return false;
  }
  return (
    normalizeOptionalString(entry.providerOverride) === probe.fallbackProvider &&
    normalizeOptionalString(entry.modelOverride) === probe.fallbackModel &&
    normalizeOptionalString(entry.modelOverrideFallbackOriginProvider) === probe.provider &&
    normalizeOptionalString(entry.modelOverrideFallbackOriginModel) === probe.model
  );
}

export function clearAutoFallbackPrimaryProbeSelection(entry: SessionEntry): void {
  delete entry.providerOverride;
  delete entry.modelOverride;
  delete entry.modelOverrideSource;
  delete entry.modelOverrideRouteResolution;
  delete entry.modelOverrideFallbackOriginProvider;
  delete entry.modelOverrideFallbackOriginModel;
  if (resolveSessionAuthProfileOverrideSource(entry) === "auto") {
    delete entry.authProfileOverride;
    delete entry.authProfileOverrideSource;
    delete entry.authProfileOverrideCompactionCount;
  }
  delete entry.fallbackNotice;
  entry.updatedAt = Date.now();
}

export function resolveAgentExecutionContract(
  cfg: OpenClawConfig | undefined,
  agentId?: string | null,
): NonNullable<NonNullable<AgentDefaultsConfig["embeddedAgent"]>["executionContract"]> | undefined {
  const defaultContract = cfg?.agents?.defaults?.embeddedAgent?.executionContract;
  if (!cfg || !agentId) {
    return defaultContract;
  }
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const agentContract = agentConfig?.embeddedAgent?.executionContract;
  return agentContract ?? defaultContract;
}

export function resolveAgentExplicitModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  const raw = resolveAgentConfig(cfg, agentId)?.model;
  return resolvePrimaryStringValue(raw);
}

export function resolveAgentEffectiveModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
): string | undefined {
  return (
    resolveAgentExplicitModelPrimary(cfg, agentId) ??
    resolvePrimaryStringValue(cfg.agents?.defaults?.model)
  );
}

function updateAgentModelPrimary(
  existing: AgentModelConfig | undefined,
  primary: string,
): AgentModelConfig {
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return { ...existing, primary };
  }
  return primary;
}

export type AgentModelPrimaryWriteTarget = "agent" | "defaults";

export function setAgentEffectiveModelPrimary(
  cfg: OpenClawConfig,
  agentId: string,
  primary: string,
  options: { target?: AgentModelPrimaryWriteTarget; forceAgent?: boolean } = {},
): AgentModelPrimaryWriteTarget {
  const id = normalizeAgentId(agentId);
  const target = options.target ?? (options.forceAgent ? "agent" : undefined);
  // An explicit agent target pins the write even without an existing model,
  // so a per-agent override never rewrites the shared default route.
  if (target !== "defaults" && (target === "agent" || resolveAgentExplicitModelPrimary(cfg, id))) {
    const entry = resolveMutableAgentEntry(cfg, id);
    if (entry) {
      entry.model = updateAgentModelPrimary(entry.model, primary);
      return "agent";
    }
    if (target === "agent") {
      if (!hasAgentRosterProperty(cfg) && listAgentIds(cfg).includes(id)) {
        cfg.agents ??= {};
        cfg.agents.entries = { [id]: { model: updateAgentModelPrimary(undefined, primary) } };
        return "agent";
      }
      throw new Error(`Could not resolve configured agent "${id}".`);
    }
  }
  cfg.agents ??= {};
  cfg.agents.defaults ??= {};
  cfg.agents.defaults.model = updateAgentModelPrimary(cfg.agents.defaults.model, primary);
  return "defaults";
}

export function resolveAgentModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  return resolveSelectedModelFallbacksOverride(
    resolveAgentModelConfigForRuntime(resolveAgentConfig(cfg, agentId)),
  );
}

function resolveFirstModelFallbacksOverride(
  candidates: Array<AgentModelConfig | undefined>,
): string[] | undefined {
  for (const candidate of candidates) {
    const fallbackOverride = resolveSelectedModelFallbacksOverride(candidate);
    if (fallbackOverride !== undefined) {
      return fallbackOverride;
    }
  }
  return undefined;
}

type SubagentModelConfigSelectionSource = "subagent" | "agent" | "default-subagent";

export type SubagentModelConfigSelectionResult = {
  raw: AgentModelConfig;
  source: SubagentModelConfigSelectionSource;
};

export function resolveSubagentModelConfigSelectionResult(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  agentConfigOverride?: Pick<AgentConfig, "model" | "subagents" | "runtime">;
}): SubagentModelConfigSelectionResult | undefined {
  const agentConfig =
    params.agentConfigOverride ??
    (params.agentId ? resolveAgentConfig(params.cfg, params.agentId) : undefined);
  const agentModel = resolveAgentModelConfigForRuntime(agentConfig);
  // Keep cron and fallback routing aligned with native spawn: per-agent subagent,
  // then the global subagent default, then agent-primary inheritance.
  const candidates = [
    [agentConfig?.subagents?.model, "subagent"],
    [params.cfg.agents?.defaults?.subagents?.model, "default-subagent"],
    [agentModel, "agent"],
  ] as const;
  for (const [raw, source] of candidates) {
    if (raw && resolvePrimaryStringValue(raw)) {
      return { raw, source };
    }
  }
  return undefined;
}

export function resolveSubagentModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  const subagentFallbacks = resolveSelectedModelFallbacksOverride(agentConfig?.subagents?.model);
  if (subagentFallbacks !== undefined) {
    return subagentFallbacks;
  }
  const selection = resolveSubagentModelConfigSelectionResult({ cfg, agentId });
  if (selection?.source === "agent" || selection?.source === "default-subagent") {
    return resolveSelectedModelFallbacksOverride(selection.raw);
  }
  return undefined;
}

export function resolveSubagentSpawnModelFallbacksOverride(
  cfg: OpenClawConfig,
  agentId: string,
): string[] | undefined {
  const agentConfig = resolveAgentConfig(cfg, agentId);
  return resolveFirstModelFallbacksOverride([
    agentConfig?.subagents?.model,
    cfg.agents?.defaults?.subagents?.model,
    resolveAgentModelConfigForRuntime(agentConfig),
  ]);
}

export function resolveRunModelFallbacksOverride(params: {
  cfg: OpenClawConfig | undefined;
  agentId?: string | null;
  sessionKey?: string | null;
}): string[] | undefined {
  if (!params.cfg) {
    return undefined;
  }
  const explicitAgentId = normalizeOptionalString(params.agentId);
  const agentId = explicitAgentId
    ? normalizeAgentId(explicitAgentId)
    : listAgentIds(params.cfg).length > 0
      ? resolveSessionAgentIds({
          config: params.cfg,
          sessionKey: params.sessionKey ?? undefined,
        }).sessionAgentId
      : undefined;
  return agentId ? resolveAgentModelFallbacksOverride(params.cfg, agentId) : undefined;
}

export type ModelFallbackAvailability =
  // `source` records whether an explicit fallbacks override owns the ladder or the
  // models were inherited from defaults; the run-override projection depends on it.
  | { kind: "active"; models: string[]; source: "explicit" | "inherited" }
  | { kind: "none_configured"; source: "explicit" | "inherited" }
  | { kind: "disabled_by_model_override" }
  | { kind: "disabled_by_model_selection_lock" };

function modelFallbackAvailabilityFromModels(
  models: string[],
  source: "explicit" | "inherited",
): ModelFallbackAvailability {
  return models.length > 0
    ? { kind: "active", models, source }
    : { kind: "none_configured", source };
}

/**
 * Projects availability onto the candidate-resolver override contract. Inherited
 * availability must project to `undefined`: the resolver then owns the ladder — it
 * re-derives the same configured fallbacks and appends the configured primary as the
 * final candidate (see model-fallback-candidates.ts). Collapsing inherited state into
 * an explicit list silently drops that last hop.
 */
export function modelFallbackOverrideFromAvailability(
  availability: ModelFallbackAvailability,
): string[] | undefined {
  switch (availability.kind) {
    case "active":
      return availability.source === "inherited" ? undefined : availability.models;
    case "none_configured":
      return availability.source === "inherited" ? undefined : [];
    default:
      return [];
  }
}

/**
 * Resolves fallback availability once for the run scope. A different user-selected model
 * disables the configured ladder; selecting the configured primary keeps its fallbacks.
 */
export function resolveModelFallbackAvailability(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string | null;
  hasSessionModelOverride: boolean;
  selectedModel?: ModelRef;
  modelOverrideSource?: "auto" | "user";
  hasAutoFallbackProvenance?: boolean;
  modelSelectionLocked?: boolean;
  modelFallbacksOverride?: string[];
  /** Declared child lineage includes visible sessions with dashboard keys. */
  subagentSpawnLineage?: boolean;
}): ModelFallbackAvailability {
  if (params.modelSelectionLocked) {
    return { kind: "disabled_by_model_selection_lock" };
  }
  if (params.modelFallbacksOverride !== undefined) {
    return modelFallbackAvailabilityFromModels(params.modelFallbacksOverride, "explicit");
  }
  const canUseConfiguredFallbacks =
    params.modelOverrideSource === "auto" ||
    (params.modelOverrideSource === undefined && params.hasAutoFallbackProvenance === true);
  let hasSessionModelOverride = params.hasSessionModelOverride;
  if (hasSessionModelOverride && !canUseConfiguredFallbacks) {
    if (!params.selectedModel) {
      return { kind: "disabled_by_model_override" };
    }
    const primary = resolveConfiguredModelRef({
      cfg: params.cfg,
      agentId: params.agentId,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    if (
      primary.provider !== params.selectedModel.provider ||
      primary.model !== params.selectedModel.model
    ) {
      return { kind: "disabled_by_model_override" };
    }
    // Older clients persisted the displayed default as a user override.
    hasSessionModelOverride = false;
  }
  const hiddenSubagent = isSubagentSessionKey(params.sessionKey);
  // Hidden children without an effective override retain their existing agent policy.
  const useSubagentFallbacks = hasSessionModelOverride
    ? hiddenSubagent || params.subagentSpawnLineage === true
    : !hiddenSubagent &&
      params.subagentSpawnLineage === true &&
      params.modelOverrideSource !== "user";
  const fallbacksOverride = useSubagentFallbacks
    ? resolveSubagentSpawnModelFallbacksOverride(params.cfg, params.agentId)
    : resolveAgentModelFallbacksOverride(params.cfg, params.agentId);
  // Auto overrides consume an explicit list, preventing a configured-primary append.
  const source =
    fallbacksOverride !== undefined || hasSessionModelOverride ? "explicit" : "inherited";
  return modelFallbackAvailabilityFromModels(
    fallbacksOverride ?? resolveAgentModelFallbackValues(params.cfg.agents?.defaults?.model),
    source,
  );
}

export function resolveEffectiveModelFallbacks(params: {
  cfg: OpenClawConfig;
  agentId: string;
  sessionKey?: string | null;
  hasSessionModelOverride: boolean;
  selectedModel?: ModelRef;
  modelOverrideSource?: "auto" | "user";
  hasAutoFallbackProvenance?: boolean;
  subagentSpawnLineage?: boolean;
}): string[] | undefined {
  return modelFallbackOverrideFromAvailability(resolveModelFallbackAvailability(params));
}

export function resolveAgentIdByWorkspacePath(
  cfg: OpenClawConfig,
  workspacePath: string,
): string | undefined {
  const normalizedWorkspacePath = resolveCanonicalWorkspacePath(workspacePath.replaceAll("\0", ""));
  return withAgentRosterFactsBatch(cfg, () => {
    let matchedAgentId: string | undefined;
    let matchedWorkspaceLength = -1;

    for (const id of listAgentIds(cfg)) {
      const workspaceDir = resolveCanonicalWorkspacePath(resolveAgentWorkspaceDir(cfg, id));
      if (!isPathInside(workspaceDir, normalizedWorkspacePath)) {
        continue;
      }
      if (workspaceDir.length > matchedWorkspaceLength) {
        matchedAgentId = id;
        matchedWorkspaceLength = workspaceDir.length;
      }
    }
    return matchedAgentId;
  });
}
