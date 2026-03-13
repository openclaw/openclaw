import type { OpenClawConfig } from "../config/config.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { sanitizeForLog } from "../terminal/ansi.js";
import {
  ensureAuthProfileStore,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveProfilesUnavailableReason,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isTimeoutError,
} from "./failover-error.js";
import { logModelFallbackDecision } from "./model-fallback-observation.js";
import type { FallbackAttempt, ModelCandidate } from "./model-fallback.types.js";
import {
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  modelKey,
  normalizeModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import { isLikelyContextOverflowError } from "./pi-embedded-helpers.js";

const log = createSubsystemLogger("model-fallback");

export type ModelFallbackRunOptions = {
  allowTransientCooldownProbe?: boolean;
};

type ModelFallbackRunFn<T> = (
  provider: string,
  model: string,
  options?: ModelFallbackRunOptions,
) => Promise<T>;

/**
 * Fallback abort check. Only treats explicit AbortError names as user aborts.
 * Message-based checks (e.g., "aborted") can mask timeouts and skip fallback.
 */
function isFallbackAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if (isFailoverError(err)) {
    return false;
  }
  const name = "name" in err ? String(err.name) : "";
  return name === "AbortError";
}

function shouldRethrowAbort(err: unknown): boolean {
  return isFallbackAbortError(err) && !isTimeoutError(err);
}

function createModelCandidateCollector(allowlist: Set<string> | null | undefined): {
  candidates: ModelCandidate[];
  addExplicitCandidate: (candidate: ModelCandidate) => void;
  addAllowlistedCandidate: (candidate: ModelCandidate) => void;
} {
  const seen = new Set<string>();
  const candidates: ModelCandidate[] = [];

  const addCandidate = (candidate: ModelCandidate, enforceAllowlist: boolean) => {
    if (!candidate.provider || !candidate.model) {
      return;
    }
    const key = modelKey(candidate.provider, candidate.model);
    if (seen.has(key)) {
      return;
    }
    if (enforceAllowlist && allowlist && !allowlist.has(key)) {
      return;
    }
    seen.add(key);
    candidates.push(candidate);
  };

  const addExplicitCandidate = (candidate: ModelCandidate) => {
    addCandidate(candidate, false);
  };
  const addAllowlistedCandidate = (candidate: ModelCandidate) => {
    addCandidate(candidate, true);
  };

  return { candidates, addExplicitCandidate, addAllowlistedCandidate };
}

type ModelFallbackErrorHandler = (attempt: {
  provider: string;
  model: string;
  error: unknown;
  attempt: number;
  total: number;
}) => void | Promise<void>;

type ModelFallbackRunResult<T> = {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
};

function buildFallbackSuccess<T>(params: {
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}): ModelFallbackRunResult<T> {
  return {
    result: params.result,
    provider: params.provider,
    model: params.model,
    attempts: params.attempts,
  };
}

async function runFallbackCandidate<T>(params: {
  run: ModelFallbackRunFn<T>;
  provider: string;
  model: string;
  options?: ModelFallbackRunOptions;
}): Promise<{ ok: true; result: T } | { ok: false; error: unknown }> {
  try {
    const result = params.options
      ? await params.run(params.provider, params.model, params.options)
      : await params.run(params.provider, params.model);
    return {
      ok: true,
      result,
    };
  } catch (err) {
    if (shouldRethrowAbort(err)) {
      throw err;
    }
    return { ok: false, error: err };
  }
}

async function runFallbackAttempt<T>(params: {
  run: ModelFallbackRunFn<T>;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
  options?: ModelFallbackRunOptions;
}): Promise<{ success: ModelFallbackRunResult<T> } | { error: unknown }> {
  const runResult = await runFallbackCandidate({
    run: params.run,
    provider: params.provider,
    model: params.model,
    options: params.options,
  });
  if (runResult.ok) {
    return {
      success: buildFallbackSuccess({
        result: runResult.result,
        provider: params.provider,
        model: params.model,
        attempts: params.attempts,
      }),
    };
  }
  return { error: runResult.error };
}

function sameModelCandidate(a: ModelCandidate, b: ModelCandidate): boolean {
  return a.provider === b.provider && a.model === b.model;
}

function throwFallbackFailureSummary(params: {
  attempts: FallbackAttempt[];
  candidates: ModelCandidate[];
  lastError: unknown;
  label: string;
  formatAttempt: (attempt: FallbackAttempt) => string;
}): never {
  if (params.attempts.length <= 1 && params.lastError) {
    throw params.lastError;
  }
  const summary =
    params.attempts.length > 0 ? params.attempts.map(params.formatAttempt).join(" | ") : "unknown";
  throw new Error(
    `All ${params.label} failed (${params.attempts.length || params.candidates.length}): ${summary}`,
    {
      cause: params.lastError instanceof Error ? params.lastError : undefined,
    },
  );
}

function resolveImageFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
  modelOverride?: string;
}): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider: params.defaultProvider,
  });
  const { candidates, addExplicitCandidate, addAllowlistedCandidate } =
    createModelCandidateCollector(allowlist);

  const addRaw = (raw: string, opts?: { allowlist?: boolean }) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    if (opts?.allowlist) {
      addAllowlistedCandidate(resolved.ref);
      return;
    }
    addExplicitCandidate(resolved.ref);
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride);
  } else {
    const primary = resolveAgentModelPrimaryValue(params.cfg?.agents?.defaults?.imageModel);
    if (primary?.trim()) {
      addRaw(primary);
    }
  }

  const imageFallbacks = resolveAgentModelFallbackValues(params.cfg?.agents?.defaults?.imageModel);

  for (const raw of imageFallbacks) {
    // Explicitly configured image fallbacks should remain reachable even when a
    // model allowlist is present.
    addRaw(raw);
  }

  return candidates;
}

function resolveFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
}): ModelCandidate[] {
  const primary = params.cfg
    ? resolveConfiguredModelRef({
        cfg: params.cfg,
        defaultProvider: DEFAULT_PROVIDER,
        defaultModel: DEFAULT_MODEL,
      })
    : null;
  const defaultProvider = primary?.provider ?? DEFAULT_PROVIDER;
  const defaultModel = primary?.model ?? DEFAULT_MODEL;
  const providerRaw = String(params.provider ?? "").trim() || defaultProvider;
  const modelRaw = String(params.model ?? "").trim() || defaultModel;
  const normalizedPrimary = normalizeModelRef(providerRaw, modelRaw);
  const configuredPrimary = normalizeModelRef(defaultProvider, defaultModel);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider,
  });
  const { candidates, addExplicitCandidate } = createModelCandidateCollector(allowlist);

  addExplicitCandidate(normalizedPrimary);

  const modelFallbacks = (() => {
    if (params.fallbacksOverride !== undefined) {
      return params.fallbacksOverride;
    }
    const configuredFallbacks = resolveAgentModelFallbackValues(
      params.cfg?.agents?.defaults?.model,
    );
    // When user runs a different provider than config, only use configured fallbacks
    // if the current model is already in that chain (e.g. session on first fallback).
    if (normalizedPrimary.provider !== configuredPrimary.provider) {
      const isConfiguredFallback = configuredFallbacks.some((raw) => {
        const resolved = resolveModelRefFromString({
          raw: String(raw ?? ""),
          defaultProvider,
          aliasIndex,
        });
        return resolved ? sameModelCandidate(resolved.ref, normalizedPrimary) : false;
      });
      return isConfiguredFallback ? configuredFallbacks : [];
    }
    // Same provider: always use full fallback chain (model version differences within provider).
    return configuredFallbacks;
  })();

  for (const raw of modelFallbacks) {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      continue;
    }
    // Fallbacks are explicit user intent; do not silently filter them by the
    // model allowlist.
    addExplicitCandidate(resolved.ref);
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addExplicitCandidate({ provider: primary.provider, model: primary.model });
  }

  return candidates;
}

const lastProbeAttempt = new Map<string, number>();
const MIN_PROBE_INTERVAL_MS = 30_000; // 30 seconds between probes per key
const PROBE_MARGIN_MS = 2 * 60 * 1000;
const PROBE_SCOPE_DELIMITER = "::";
const PROBE_STATE_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_PROBE_KEYS = 256;

function resolveProbeThrottleKey(provider: string, agentDir?: string): string {
  const scope = String(agentDir ?? "").trim();
  return scope ? `${scope}${PROBE_SCOPE_DELIMITER}${provider}` : provider;
}

function pruneProbeState(now: number): void {
  for (const [key, ts] of lastProbeAttempt) {
    if (!Number.isFinite(ts) || ts <= 0 || now - ts > PROBE_STATE_TTL_MS) {
      lastProbeAttempt.delete(key);
    }
  }
}

function enforceProbeStateCap(): void {
  while (lastProbeAttempt.size > MAX_PROBE_KEYS) {
    let oldestKey: string | null = null;
    let oldestTs = Number.POSITIVE_INFINITY;
    for (const [key, ts] of lastProbeAttempt) {
      if (ts < oldestTs) {
        oldestKey = key;
        oldestTs = ts;
      }
    }
    if (!oldestKey) {
      break;
    }
    lastProbeAttempt.delete(oldestKey);
  }
}

function isProbeThrottleOpen(now: number, throttleKey: string): boolean {
  pruneProbeState(now);
  const lastProbe = lastProbeAttempt.get(throttleKey) ?? 0;
  return now - lastProbe >= MIN_PROBE_INTERVAL_MS;
}

function markProbeAttempt(now: number, throttleKey: string): void {
  pruneProbeState(now);
  lastProbeAttempt.set(throttleKey, now);
  enforceProbeStateCap();
}

function isTransientCooldownReason(reason: FailoverReason | null | undefined): boolean {
  return reason === "rate_limit" || reason === "overloaded";
}

function shouldProbePrimaryDuringCooldown(params: {
  isPrimary: boolean;
  hasFallbackCandidates: boolean;
  preferCrossProviderFallback: boolean;
  now: number;
  throttleKey: string;
  soonestCooldownExpiry: number | null;
}): boolean {
  if (!params.isPrimary || !params.hasFallbackCandidates) {
    return false;
  }

  if (params.preferCrossProviderFallback) {
    return false;
  }

  if (!isProbeThrottleOpen(params.now, params.throttleKey)) {
    return false;
  }

  const soonest = params.soonestCooldownExpiry;
  if (soonest === null || !Number.isFinite(soonest)) {
    return true;
  }

  // Probe when cooldown already expired or within the configured margin.
  return params.now >= soonest - PROBE_MARGIN_MS;
}

/** @internal – exposed for unit tests only */
export const _probeThrottleInternals = {
  lastProbeAttempt,
  MIN_PROBE_INTERVAL_MS,
  PROBE_MARGIN_MS,
  PROBE_STATE_TTL_MS,
  MAX_PROBE_KEYS,
  resolveProbeThrottleKey,
  isProbeThrottleOpen,
  pruneProbeState,
  markProbeAttempt,
} as const;

type ProviderAvailabilitySnapshot = {
  profileIds: string[];
  allProfilesInCooldown: boolean;
  isRunnableNow: boolean;
  unavailableReason: FailoverReason | null;
  soonestCooldownExpiry: number | null;
};

function createProviderAvailabilityResolver(params: {
  cfg: OpenClawConfig | undefined;
  authStore: ReturnType<typeof ensureAuthProfileStore>;
}): (provider: string) => ProviderAvailabilitySnapshot {
  const cache = new Map<string, ProviderAvailabilitySnapshot>();
  return (provider: string) => {
    const cached = cache.get(provider);
    if (cached) {
      return cached;
    }

    const profileIds = resolveAuthProfileOrder({
      cfg: params.cfg,
      store: params.authStore,
      provider,
    });
    const hasAvailableProfile = profileIds.some((id) => !isProfileInCooldown(params.authStore, id));
    const allProfilesInCooldown = profileIds.length > 0 && !hasAvailableProfile;
    const snapshot: ProviderAvailabilitySnapshot = {
      profileIds,
      allProfilesInCooldown,
      isRunnableNow: profileIds.length === 0 || hasAvailableProfile,
      unavailableReason: allProfilesInCooldown
        ? (resolveProfilesUnavailableReason({
            store: params.authStore,
            profileIds,
          }) ?? "unknown")
        : null,
      soonestCooldownExpiry: allProfilesInCooldown
        ? getSoonestCooldownExpiry(params.authStore, profileIds)
        : null,
    };
    cache.set(provider, snapshot);
    return snapshot;
  };
}

function resolveCandidateRunOrder(params: {
  candidates: ModelCandidate[];
  requestedProvider: string;
  resolveProviderAvailability: (provider: string) => ProviderAvailabilitySnapshot;
}): number[] {
  const defaultOrder = params.candidates.map((_, index) => index);
  if (defaultOrder.length <= 1) {
    return defaultOrder;
  }

  const requestedProviderAvailability = params.resolveProviderAvailability(
    params.requestedProvider,
  );
  if (
    !requestedProviderAvailability.allProfilesInCooldown ||
    !isTransientCooldownReason(requestedProviderAvailability.unavailableReason)
  ) {
    return defaultOrder;
  }

  const crossProviderIndexes = defaultOrder.slice(1).filter((index) => {
    return params.candidates[index]?.provider !== params.requestedProvider;
  });
  const hasRunnableCrossProviderFallback = crossProviderIndexes.some((index) => {
    const candidate = params.candidates[index];
    return candidate ? params.resolveProviderAvailability(candidate.provider).isRunnableNow : false;
  });
  if (!hasRunnableCrossProviderFallback) {
    return defaultOrder;
  }

  const sameProviderIndexes = defaultOrder.slice(1).filter((index) => {
    return params.candidates[index]?.provider === params.requestedProvider;
  });
  return [0, ...crossProviderIndexes, ...sameProviderIndexes];
}

type CooldownDecision =
  | {
      type: "skip";
      reason: FailoverReason;
      error: string;
    }
  | {
      type: "attempt";
      reason: FailoverReason;
      markProbe: boolean;
    };

function resolveCooldownDecision(params: {
  candidate: ModelCandidate;
  isPrimary: boolean;
  requestedModel: boolean;
  hasFallbackCandidates: boolean;
  hasRunnableCrossProviderFallback: boolean;
  now: number;
  probeThrottleKey: string;
  unavailableReason: FailoverReason | null;
  soonestCooldownExpiry: number | null;
}): CooldownDecision {
  const inferredReason = params.unavailableReason ?? "unknown";
  const preferCrossProviderFallback =
    params.isPrimary &&
    isTransientCooldownReason(inferredReason) &&
    params.hasRunnableCrossProviderFallback;
  const shouldProbe = shouldProbePrimaryDuringCooldown({
    isPrimary: params.isPrimary,
    hasFallbackCandidates: params.hasFallbackCandidates,
    preferCrossProviderFallback,
    now: params.now,
    throttleKey: params.probeThrottleKey,
    soonestCooldownExpiry: params.soonestCooldownExpiry,
  });
  const isPersistentAuthIssue = inferredReason === "auth" || inferredReason === "auth_permanent";
  if (isPersistentAuthIssue) {
    return {
      type: "skip",
      reason: inferredReason,
      error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`,
    };
  }

  // Billing is semi-persistent: the user may fix their balance, or a transient
  // 402 might have been misclassified. Probe single-provider setups on the
  // standard throttle so they can recover without a restart; when fallbacks
  // exist, only probe near cooldown expiry so the fallback chain stays preferred.
  if (inferredReason === "billing") {
    const shouldProbeSingleProviderBilling =
      params.isPrimary &&
      !params.hasFallbackCandidates &&
      isProbeThrottleOpen(params.now, params.probeThrottleKey);
    if (params.isPrimary && (shouldProbe || shouldProbeSingleProviderBilling)) {
      return { type: "attempt", reason: inferredReason, markProbe: true };
    }
    return {
      type: "skip",
      reason: inferredReason,
      error: `Provider ${params.candidate.provider} has ${inferredReason} issue (skipping all models)`,
    };
  }

  // For primary: try when requested model or when probe allows.
  // For same-provider fallbacks: only relax cooldown on transient provider
  // limits, which are often model-scoped and can recover on a sibling model.
  const shouldAttemptDespiteCooldown =
    (params.isPrimary && (!params.requestedModel || shouldProbe)) ||
    (!params.isPrimary &&
      (inferredReason === "rate_limit" ||
        inferredReason === "overloaded" ||
        inferredReason === "unknown"));
  if (!shouldAttemptDespiteCooldown) {
    return {
      type: "skip",
      reason: inferredReason,
      error: `Provider ${params.candidate.provider} is in cooldown (all profiles unavailable)`,
    };
  }

  return {
    type: "attempt",
    reason: inferredReason,
    markProbe: params.isPrimary && shouldProbe,
  };
}

export async function runWithModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  runId?: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  run: ModelFallbackRunFn<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
  });
  const authStore = params.cfg
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;
  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;
  const cooldownProbeUsedProviders = new Set<string>();
  const resolveProviderAvailability = authStore
    ? createProviderAvailabilityResolver({
        cfg: params.cfg,
        authStore,
      })
    : null;
  const candidateRunOrder = resolveProviderAvailability
    ? resolveCandidateRunOrder({
        candidates,
        requestedProvider: params.provider,
        resolveProviderAvailability,
      })
    : candidates.map((_, index) => index);

  const hasFallbackCandidates = candidates.length > 1;

  for (let orderIndex = 0; orderIndex < candidateRunOrder.length; orderIndex += 1) {
    const candidateIndex = candidateRunOrder[orderIndex];
    const candidate = candidates[candidateIndex];
    const isPrimary = candidateIndex === 0;
    const requestedModel =
      params.provider === candidate.provider && params.model === candidate.model;
    let runOptions: ModelFallbackRunOptions | undefined;
    let attemptedDuringCooldown = false;
    let transientProbeProviderForAttempt: string | null = null;
    let shouldConsumeTransientProbeSlotOnFailure = false;
    if (authStore && resolveProviderAvailability) {
      const providerAvailability = resolveProviderAvailability(candidate.provider);
      const profileIds = providerAvailability.profileIds;

      if (providerAvailability.allProfilesInCooldown) {
        // All profiles for this provider are in cooldown.
        const now = Date.now();
        const probeThrottleKey = resolveProbeThrottleKey(candidate.provider, params.agentDir);
        const hasRunnableCrossProviderFallback = candidateRunOrder
          .slice(orderIndex + 1)
          .some((nextCandidateIndex) => {
            const nextCandidate = candidates[nextCandidateIndex];
            return nextCandidate
              ? nextCandidate.provider !== candidate.provider &&
                  resolveProviderAvailability(nextCandidate.provider).isRunnableNow
              : false;
          });
        const decision = resolveCooldownDecision({
          candidate,
          isPrimary,
          requestedModel,
          hasFallbackCandidates,
          hasRunnableCrossProviderFallback,
          now,
          probeThrottleKey,
          unavailableReason: providerAvailability.unavailableReason,
          soonestCooldownExpiry: providerAvailability.soonestCooldownExpiry,
        });

        if (decision.type === "skip") {
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            error: decision.error,
            reason: decision.reason,
          });
          logModelFallbackDecision({
            decision: "skip_candidate",
            runId: params.runId,
            requestedProvider: params.provider,
            requestedModel: params.model,
            candidate,
            attempt: orderIndex + 1,
            total: candidates.length,
            reason: decision.reason,
            error: decision.error,
            nextCandidate: candidates[candidateRunOrder[orderIndex + 1] ?? -1],
            isPrimary,
            requestedModelMatched: requestedModel,
            fallbackConfigured: hasFallbackCandidates,
            profileCount: profileIds.length,
          });
          continue;
        }

        if (decision.markProbe) {
          markProbeAttempt(now, probeThrottleKey);
        }
        if (
          decision.reason === "rate_limit" ||
          decision.reason === "overloaded" ||
          decision.reason === "billing" ||
          decision.reason === "unknown"
        ) {
          // Probe at most once per provider per fallback run when all profiles
          // are cooldowned. Re-probing every same-provider candidate can stall
          // cross-provider fallback on providers with long internal retries.
          const isTransientCooldownReason =
            decision.reason === "rate_limit" ||
            decision.reason === "overloaded" ||
            decision.reason === "unknown";
          if (isTransientCooldownReason && cooldownProbeUsedProviders.has(candidate.provider)) {
            const error = `Provider ${candidate.provider} is in cooldown (probe already attempted this run)`;
            attempts.push({
              provider: candidate.provider,
              model: candidate.model,
              error,
              reason: decision.reason,
            });
            logModelFallbackDecision({
              decision: "skip_candidate",
              runId: params.runId,
              requestedProvider: params.provider,
              requestedModel: params.model,
              candidate,
              attempt: orderIndex + 1,
              total: candidates.length,
              reason: decision.reason,
              error,
              nextCandidate: candidates[candidateRunOrder[orderIndex + 1] ?? -1],
              isPrimary,
              requestedModelMatched: requestedModel,
              fallbackConfigured: hasFallbackCandidates,
              profileCount: profileIds.length,
            });
            continue;
          }
          runOptions = { allowTransientCooldownProbe: true };
          if (isTransientCooldownReason) {
            transientProbeProviderForAttempt = candidate.provider;
            shouldConsumeTransientProbeSlotOnFailure = !isPrimary;
          }
        }
        attemptedDuringCooldown = true;
        logModelFallbackDecision({
          decision: "probe_cooldown_candidate",
          runId: params.runId,
          requestedProvider: params.provider,
          requestedModel: params.model,
          candidate,
          attempt: orderIndex + 1,
          total: candidates.length,
          reason: decision.reason,
          nextCandidate: candidates[candidateRunOrder[orderIndex + 1] ?? -1],
          isPrimary,
          requestedModelMatched: requestedModel,
          fallbackConfigured: hasFallbackCandidates,
          allowTransientCooldownProbe: runOptions?.allowTransientCooldownProbe,
          profileCount: profileIds.length,
        });
      }
    }

    const attemptRun = await runFallbackAttempt({
      run: params.run,
      ...candidate,
      attempts,
      options: runOptions,
    });
    if ("success" in attemptRun) {
      if (candidateIndex > 0 || attempts.length > 0 || attemptedDuringCooldown) {
        logModelFallbackDecision({
          decision: "candidate_succeeded",
          runId: params.runId,
          requestedProvider: params.provider,
          requestedModel: params.model,
          candidate,
          attempt: orderIndex + 1,
          total: candidates.length,
          previousAttempts: attempts,
          isPrimary,
          requestedModelMatched: requestedModel,
          fallbackConfigured: hasFallbackCandidates,
        });
      }
      const notFoundAttempt =
        candidateIndex > 0 ? attempts.find((a) => a.reason === "model_not_found") : undefined;
      if (notFoundAttempt) {
        log.warn(
          `Model "${sanitizeForLog(notFoundAttempt.provider)}/${sanitizeForLog(notFoundAttempt.model)}" not found. Fell back to "${sanitizeForLog(candidate.provider)}/${sanitizeForLog(candidate.model)}".`,
        );
      }
      return attemptRun.success;
    }
    const err = attemptRun.error;
    {
      if (transientProbeProviderForAttempt) {
        const probeFailureReason = describeFailoverError(err).reason;
        const shouldPreserveTransientProbeSlot =
          !shouldConsumeTransientProbeSlotOnFailure ||
          probeFailureReason === "model_not_found" ||
          probeFailureReason === "format" ||
          probeFailureReason === "auth" ||
          probeFailureReason === "auth_permanent" ||
          probeFailureReason === "session_expired";
        if (!shouldPreserveTransientProbeSlot) {
          cooldownProbeUsedProviders.add(transientProbeProviderForAttempt);
        }
      }
      // Context overflow errors should be handled by the inner runner's
      // compaction/retry logic, not by model fallback.  If one escapes as a
      // throw, rethrow it immediately rather than trying a different model
      // that may have a smaller context window and fail worse.
      const errMessage = err instanceof Error ? err.message : String(err);
      if (isLikelyContextOverflowError(errMessage)) {
        throw err;
      }
      const normalized =
        coerceToFailoverError(err, {
          provider: candidate.provider,
          model: candidate.model,
        }) ?? err;

      // Even unrecognized errors should not abort the fallback loop when
      // there are remaining candidates.  Only abort/context-overflow errors
      // (handled above) are truly non-retryable.
      const isKnownFailover = isFailoverError(normalized);
      if (!isKnownFailover && orderIndex === candidateRunOrder.length - 1) {
        throw err;
      }

      lastError = isKnownFailover ? normalized : err;
      const described = describeFailoverError(normalized);
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described.message,
        reason: described.reason ?? "unknown",
        status: described.status,
        code: described.code,
      });
      logModelFallbackDecision({
        decision: "candidate_failed",
        runId: params.runId,
        requestedProvider: params.provider,
        requestedModel: params.model,
        candidate,
        attempt: orderIndex + 1,
        total: candidates.length,
        reason: described.reason,
        status: described.status,
        code: described.code,
        error: described.message,
        nextCandidate: candidates[candidateRunOrder[orderIndex + 1] ?? -1],
        isPrimary,
        requestedModelMatched: requestedModel,
        fallbackConfigured: hasFallbackCandidates,
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: isKnownFailover ? normalized : err,
        attempt: orderIndex + 1,
        total: candidates.length,
      });
    }
  }

  throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "models",
    formatAttempt: (attempt) =>
      `${attempt.provider}/${attempt.model}: ${attempt.error}${
        attempt.reason ? ` (${attempt.reason})` : ""
      }`,
  });
}

export async function runWithImageModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: ModelFallbackErrorHandler;
}): Promise<ModelFallbackRunResult<T>> {
  const candidates = resolveImageFallbackCandidates({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    modelOverride: params.modelOverride,
  });
  if (candidates.length === 0) {
    throw new Error(
      "No image model configured. Set agents.defaults.imageModel.primary or agents.defaults.imageModel.fallbacks.",
    );
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const attemptRun = await runFallbackAttempt({ run: params.run, ...candidate, attempts });
    if ("success" in attemptRun) {
      return attemptRun.success;
    }
    {
      const err = attemptRun.error;
      lastError = err;
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: err instanceof Error ? err.message : String(err),
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: err,
        attempt: i + 1,
        total: candidates.length,
      });
    }
  }

  throwFallbackFailureSummary({
    attempts,
    candidates,
    lastError,
    label: "image models",
    formatAttempt: (attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`,
  });
}
