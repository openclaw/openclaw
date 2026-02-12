import type { OpenClawConfig } from "../config/config.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import {
  CircuitBreakerOpenError,
  createCircuitBreaker,
  type CircuitBreaker,
} from "../infra/circuit-breaker.js";
import {
  ensureAuthProfileStore,
  getProfileCooldownRemainingMs,
  isProfileApproachingCooldown,
  isProfileInCooldown,
  resolveAuthProfileOrder,
} from "./auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import {
  coerceToFailoverError,
  describeFailoverError,
  isFailoverError,
  isTimeoutError,
} from "./failover-error.js";
import {
  buildModelAliasIndex,
  modelKey,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";

// Per-provider circuit breakers for instant fail-fast on repeated upstream failures.
const providerBreakers = new Map<string, CircuitBreaker>();

type ModelCooldownState = {
  until: number;
  failures: number;
  lastReason: FailoverReason;
};

// Per-model cooldown state for transient limits (rate limiting, upstream overload, etc).
const modelCooldowns = new Map<string, ModelCooldownState>();

export type ModelCooldownSnapshotEntry = {
  key: string;
  provider: string;
  model: string;
  untilMs: number;
  remainingMs: number;
  failures: number;
  reason: FailoverReason;
};

/** Reset all provider circuit breakers. Exported for test isolation. */
export function resetProviderBreakers(): void {
  providerBreakers.clear();
}

/** Reset all model cooldown state. Exported for test isolation. */
export function resetModelCooldowns(): void {
  modelCooldowns.clear();
}

export function getModelCooldownSnapshot(now = Date.now()): ModelCooldownSnapshotEntry[] {
  const out: ModelCooldownSnapshotEntry[] = [];
  for (const [key, state] of modelCooldowns.entries()) {
    const remainingMs = state.until - now;
    if (remainingMs <= 0) {
      modelCooldowns.delete(key);
      continue;
    }
    const slash = key.indexOf("/");
    const provider = slash === -1 ? "" : key.slice(0, slash);
    const model = slash === -1 ? key : key.slice(slash + 1);
    out.push({
      key,
      provider,
      model,
      untilMs: state.until,
      remainingMs,
      failures: state.failures,
      reason: state.lastReason,
    });
  }
  return out.toSorted((a, b) => a.remainingMs - b.remainingMs);
}

function getProviderBreaker(provider: string): CircuitBreaker {
  let breaker = providerBreakers.get(provider);
  if (!breaker) {
    breaker = createCircuitBreaker(provider, {
      failureThreshold: 5,
      resetTimeoutMs: 60_000,
      shouldTrip: (err) => {
        const normalized = coerceToFailoverError(err);
        if (!normalized) {
          return true;
        }
        const described = describeFailoverError(normalized);
        // Auth and billing errors won't fix themselves with time — don't trip the breaker.
        return described.reason !== "auth" && described.reason !== "billing";
      },
    });
    providerBreakers.set(provider, breaker);
  }
  return breaker;
}

function getModelCooldownRemainingMs(key: string, now: number): number {
  const state = modelCooldowns.get(key);
  if (!state) {
    return 0;
  }
  const remaining = state.until - now;
  if (remaining <= 0) {
    modelCooldowns.delete(key);
    return 0;
  }
  return remaining;
}

export function isModelCoolingDown(
  ref: { provider?: string | null; model?: string | null },
  now = Date.now(),
): boolean {
  const provider = ref.provider?.trim();
  const model = ref.model?.trim();
  if (!provider || !model) {
    return false;
  }
  return getModelCooldownRemainingMs(modelKey(provider, model), now) > 0;
}

function shouldModelEnterCooldown(reason?: FailoverReason): boolean {
  // Auth failures are often recoverable quickly (token refresh / provider-side hiccup).
  // Do not quarantine the model for long windows; let auth-profile health handle rotation.
  return reason === "rate_limit" || reason === "timeout";
}

/**
 * Parse a "retry after" duration hint from an error message.
 * Supports patterns like "quota will reset after 4h37m20s", "retry after 120s",
 * "Retry-After: 3600", and structured "Xh Ym Zs" durations.
 * Returns milliseconds, or 0 if no hint found.
 */
const RETRY_AFTER_DURATION_RE =
  /(?:reset|retry)[- ]?after[:\s]+(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/i;
const RETRY_AFTER_SECONDS_RE = /retry[- ]?after[:\s]+(\d+)\s*(?:seconds?)?$/im;

export function parseRetryAfterMs(errorMessage: string): number {
  if (!errorMessage) {
    return 0;
  }
  // Match "Xh Ym Zs" duration pattern (e.g., "quota will reset after 4h37m20s")
  const durationMatch = errorMessage.match(RETRY_AFTER_DURATION_RE);
  if (durationMatch) {
    const hours = Number(durationMatch[1] || 0);
    const minutes = Number(durationMatch[2] || 0);
    const seconds = Number(durationMatch[3] || 0);
    const totalMs = (hours * 3600 + minutes * 60 + seconds) * 1000;
    if (totalMs > 0) {
      return totalMs;
    }
  }
  // Match plain seconds (e.g., "Retry-After: 3600")
  const secondsMatch = errorMessage.match(RETRY_AFTER_SECONDS_RE);
  if (secondsMatch) {
    const seconds = Number(secondsMatch[1]);
    if (seconds > 0) {
      return seconds * 1000;
    }
  }
  return 0;
}

function computeModelCooldownMs(params: {
  reason: FailoverReason;
  failures: number;
  /** Parsed retry-after hint from the error, in ms. Overrides default backoff when present. */
  retryAfterHintMs?: number;
}): number {
  // Hard cap: never cooldown longer than 6 hours.
  const ABSOLUTE_MAX_COOLDOWN_MS = 6 * 60 * 60_000;
  const DEFAULT_MAX_COOLDOWN_MS = 10 * 60_000;

  // When the upstream tells us exactly how long to wait, respect it (capped).
  if (params.retryAfterHintMs && params.retryAfterHintMs > 0) {
    return Math.min(ABSOLUTE_MAX_COOLDOWN_MS, params.retryAfterHintMs);
  }

  const base = params.reason === "timeout" ? 20_000 : 60_000;
  const factor = Math.min(8, Math.max(1, 2 ** Math.max(0, params.failures - 1)));
  return Math.min(DEFAULT_MAX_COOLDOWN_MS, base * factor);
}

export function __recordModelFailureForTest(params: {
  provider: string;
  model: string;
  reason: FailoverReason;
  errorMessage?: string;
}): void {
  recordModelFailure(params);
}

function recordModelFailure(params: {
  provider: string;
  model: string;
  reason: FailoverReason;
  errorMessage?: string;
}): {
  cooldownMs: number;
  remainingMs: number;
} {
  const key = modelKey(params.provider, params.model);
  const now = Date.now();
  const existing = modelCooldowns.get(key);
  const failures = (existing?.failures ?? 0) + 1;
  const retryAfterHintMs = params.errorMessage ? parseRetryAfterMs(params.errorMessage) : 0;
  const cooldownMs = computeModelCooldownMs({ reason: params.reason, failures, retryAfterHintMs });
  const until = Math.max(existing?.until ?? 0, now + cooldownMs);
  modelCooldowns.set(key, { until, failures, lastReason: params.reason });

  if (retryAfterHintMs > 0) {
    console.warn(
      `\x1b[33m[model-fallback]\x1b[0m \x1b[33mModel ${params.provider}/${params.model} rate limited. ` +
        `Upstream retry-after: ${formatCooldownDuration(retryAfterHintMs)}. ` +
        `Cooldown set to ${formatCooldownDuration(cooldownMs)}.\x1b[0m`,
    );
  }

  return { cooldownMs, remainingMs: until - now };
}

function recordModelSuccess(provider: string, model: string): void {
  modelCooldowns.delete(modelKey(provider, model));
}

type ModelCandidate = {
  provider: string;
  model: string;
};

function resolvePinnedThinkingModel(params: { cfg: OpenClawConfig | undefined }): string | null {
  const autoPickFromPool = params.cfg?.agents?.defaults?.modelByComplexity?.autoPickFromPool;
  if (autoPickFromPool !== false) {
    return null;
  }
  const modelCfg = params.cfg?.agents?.defaults?.model as { primary?: string } | string | undefined;
  if (typeof modelCfg === "string") {
    const trimmed = modelCfg.trim();
    return trimmed || null;
  }
  const trimmed = modelCfg?.primary?.trim() ?? "";
  return trimmed || null;
}

function resolvePinnedCodingModel(params: {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
}): string | null {
  const modelOverride = params.modelOverride?.trim();
  if (modelOverride) {
    return modelOverride;
  }
  const codingCfg = params.cfg?.agents?.defaults?.codingModel as
    | { primary?: string }
    | string
    | undefined;
  if (typeof codingCfg === "string") {
    const trimmed = codingCfg.trim();
    return trimmed || null;
  }
  const trimmed = codingCfg?.primary?.trim() ?? "";
  return trimmed || null;
}

type FallbackAttempt = {
  provider: string;
  model: string;
  error: string;
  reason?: FailoverReason;
  status?: number;
  code?: string;
};

function isAbortError(err: unknown): boolean {
  if (!err || typeof err !== "object") {
    return false;
  }
  if (isFailoverError(err)) {
    return false;
  }
  const name = "name" in err ? String(err.name) : "";
  // Only treat explicit AbortError names as user aborts.
  // Message-based checks (e.g., "aborted") can mask timeouts and skip fallback.
  return name === "AbortError";
}

function shouldRethrowAbort(err: unknown): boolean {
  return isAbortError(err) && !isTimeoutError(err);
}

/**
 * Format milliseconds into a human-readable duration string.
 */
function formatCooldownDuration(ms: number): string {
  if (ms <= 0) {
    return "0s";
  }
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);

  if (hours > 0) {
    const remainingMinutes = minutes % 60;
    return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  }
  if (minutes > 0) {
    const remainingSeconds = seconds % 60;
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  return `${seconds}s`;
}

/**
 * Log a warning when a model is switched due to cooldown.
 */
function logCooldownSwitch(params: {
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
  reason: "cooldown" | "approaching_cooldown" | "all_profiles_cooldown";
  cooldownRemainingMs?: number;
}): void {
  const { fromProvider, fromModel, toProvider, toModel, reason, cooldownRemainingMs } = params;
  const fromKey = `${fromProvider}/${fromModel}`;
  const toKey = `${toProvider}/${toModel}`;

  const cooldownInfo = cooldownRemainingMs
    ? ` (cooldown: ${formatCooldownDuration(cooldownRemainingMs)})`
    : "";

  switch (reason) {
    case "cooldown":
      console.warn(
        `\x1b[33m[model-fallback]\x1b[0m \x1b[33mModel ${fromKey} is in cooldown${cooldownInfo}. Switching to ${toKey}.\x1b[0m`,
      );
      break;
    case "approaching_cooldown":
      console.warn(
        `\x1b[33m[model-fallback]\x1b[0m \x1b[33mModel ${fromKey} has accumulated errors and may enter cooldown soon. Proactively switching to ${toKey}.\x1b[0m`,
      );
      break;
    case "all_profiles_cooldown":
      console.warn(
        `\x1b[33m[model-fallback]\x1b[0m \x1b[33mAll profiles for ${fromKey} are in cooldown${cooldownInfo}. Switching to ${toKey}.\x1b[0m`,
      );
      break;
  }
}

/**
 * Log a warning when a model enters cooldown but no fallback is available.
 */
function logCooldownNoFallback(params: {
  provider: string;
  model: string;
  cooldownRemainingMs?: number;
}): void {
  const { provider, model, cooldownRemainingMs } = params;
  const key = `${provider}/${model}`;
  const cooldownInfo = cooldownRemainingMs
    ? ` Cooldown remaining: ${formatCooldownDuration(cooldownRemainingMs)}.`
    : "";
  console.warn(
    `\x1b[31m[model-fallback]\x1b[0m \x1b[31mModel ${key} is in cooldown and no fallback is available.${cooldownInfo}\x1b[0m`,
  );
}

function buildAllowedModelKeys(
  cfg: OpenClawConfig | undefined,
  defaultProvider: string,
): Set<string> | null {
  const rawAllowlist = (() => {
    const modelMap = cfg?.agents?.defaults?.models ?? {};
    return Object.keys(modelMap);
  })();
  if (rawAllowlist.length === 0) {
    return null;
  }
  const keys = new Set<string>();
  for (const raw of rawAllowlist) {
    const parsed = parseModelRef(String(raw ?? ""), defaultProvider);
    if (!parsed) {
      continue;
    }
    keys.add(modelKey(parsed.provider, parsed.model));
  }
  return keys.size > 0 ? keys : null;
}

function resolveCodingFallbackCandidates(params: {
  cfg: OpenClawConfig | undefined;
  defaultProvider: string;
  modelOverride?: string;
}): ModelCandidate[] {
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider: params.defaultProvider,
  });
  const allowlist = buildAllowedModelKeys(params.cfg, params.defaultProvider);
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

  const addRaw = (raw: string, enforceAllowlist: boolean) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    addCandidate(resolved.ref, enforceAllowlist);
  };

  const pinnedCodingModel = resolvePinnedCodingModel({
    cfg: params.cfg,
    modelOverride: params.modelOverride,
  });

  if (pinnedCodingModel) {
    addRaw(pinnedCodingModel, false);
  } else {
    const codingModel = params.cfg?.agents?.defaults?.codingModel as
      | { primary?: string }
      | string
      | undefined;
    const primary = typeof codingModel === "string" ? codingModel.trim() : codingModel?.primary;
    if (primary?.trim()) {
      addRaw(primary, false);
    }
  }

  // When coding selector is explicitly set (non-auto), do not route to other models.
  if (pinnedCodingModel) {
    return candidates;
  }

  const codingFallbacks = (() => {
    const codingModel = params.cfg?.agents?.defaults?.codingModel as
      | { fallbacks?: string[] }
      | string
      | undefined;
    if (codingModel && typeof codingModel === "object") {
      return codingModel.fallbacks ?? [];
    }
    return [];
  })();

  for (const raw of codingFallbacks) {
    addRaw(raw, true);
  }

  // Auto-populate fallbacks from allowlist when none are explicitly configured.
  if (codingFallbacks.length === 0) {
    const allowlistKeys = Object.keys(params.cfg?.agents?.defaults?.models ?? {});
    for (const raw of allowlistKeys) {
      addRaw(raw, false);
    }
  }

  return candidates;
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
  const allowlist = buildAllowedModelKeys(params.cfg, params.defaultProvider);
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

  const addRaw = (raw: string, enforceAllowlist: boolean) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: params.defaultProvider,
      aliasIndex,
    });
    if (!resolved) {
      return;
    }
    addCandidate(resolved.ref, enforceAllowlist);
  };

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride, false);
  } else {
    const imageModel = params.cfg?.agents?.defaults?.imageModel as
      | { primary?: string }
      | string
      | undefined;
    const primary = typeof imageModel === "string" ? imageModel.trim() : imageModel?.primary;
    if (primary?.trim()) {
      addRaw(primary, false);
    }
  }

  const imageFallbacks = (() => {
    const imageModel = params.cfg?.agents?.defaults?.imageModel as
      | { fallbacks?: string[] }
      | string
      | undefined;
    if (imageModel && typeof imageModel === "object") {
      return imageModel.fallbacks ?? [];
    }
    return [];
  })();

  for (const raw of imageFallbacks) {
    addRaw(raw, true);
  }

  // Auto-populate fallbacks from allowlist when none are explicitly configured.
  if (imageFallbacks.length === 0) {
    const allowlistKeys = Object.keys(params.cfg?.agents?.defaults?.models ?? {});
    for (const raw of allowlistKeys) {
      addRaw(raw, false);
    }
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
  const provider = String(params.provider ?? "").trim() || defaultProvider;
  const model = String(params.model ?? "").trim() || defaultModel;
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
  });

  const pinnedThinkingModel = resolvePinnedThinkingModel({ cfg: params.cfg });
  // When thinking selector is explicitly set (non-auto), force that configured model globally.
  // This prevents stale session/runtime hints from routing to a different provider/model.
  if (params.fallbacksOverride === undefined && pinnedThinkingModel) {
    const resolvedPinned = resolveModelRefFromString({
      raw: pinnedThinkingModel,
      defaultProvider,
      aliasIndex,
    });
    if (resolvedPinned) {
      return [resolvedPinned.ref];
    }
  }

  const allowlist = buildAllowedModelKeys(params.cfg, defaultProvider);
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

  addCandidate({ provider, model }, false);

  const modelFallbacks = (() => {
    if (params.fallbacksOverride !== undefined) {
      return params.fallbacksOverride;
    }
    const model = params.cfg?.agents?.defaults?.model as
      | { fallbacks?: string[] }
      | string
      | undefined;
    if (model && typeof model === "object") {
      return model.fallbacks ?? [];
    }
    return [];
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
    addCandidate(resolved.ref, true);
  }

  // Auto-populate fallbacks from allowlist when none are explicitly configured.
  if (params.fallbacksOverride === undefined && modelFallbacks.length === 0) {
    const allowlistKeys = Object.keys(params.cfg?.agents?.defaults?.models ?? {});
    for (const raw of allowlistKeys) {
      const resolved = resolveModelRefFromString({
        raw: String(raw ?? ""),
        defaultProvider,
        aliasIndex,
      });
      if (resolved) {
        addCandidate(resolved.ref, false);
      }
    }
  }

  if (params.fallbacksOverride === undefined && primary?.provider && primary.model) {
    addCandidate({ provider: primary.provider, model: primary.model }, false);
  }

  return candidates;
}

async function runWithCandidates<T>(params: {
  cfg: OpenClawConfig | undefined;
  agentDir?: string;
  candidates: ModelCandidate[];
  run: (provider: string, model: string) => Promise<T>;
  onError?: (attempt: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
  }) => void | Promise<void>;
}): Promise<{
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}> {
  let candidates = params.candidates;
  const authStore = params.cfg
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;

  // Sort non-primary candidates: paid models before free-tier, then by provider health.
  if (candidates.length > 2) {
    const [primary, ...tail] = candidates;

    const isFreeModel = (c: ModelCandidate): boolean => c.model.endsWith(":free");

    const healthScore = (c: ModelCandidate): number => {
      if (!authStore) {
        return 0;
      }
      const profileIds = resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: c.provider,
      });
      if (profileIds.length === 0) {
        return 1; // unknown provider — neutral priority
      }
      if (profileIds.every((id) => isProfileInCooldown(authStore, id))) {
        return 3;
      }
      if (profileIds.some((id) => isProfileApproachingCooldown(authStore, id))) {
        return 2;
      }
      return 0; // healthy
    };

    tail.sort((a, b) => {
      // Deprioritize free-tier models: paid first, free last
      const aFree = isFreeModel(a) ? 1 : 0;
      const bFree = isFreeModel(b) ? 1 : 0;
      if (aFree !== bFree) {
        return aFree - bFree;
      }
      // Within same tier (both paid or both free), sort by provider health
      return healthScore(a) - healthScore(b);
    });

    candidates = [primary, ...tail];
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    const key = modelKey(candidate.provider, candidate.model);
    const now = Date.now();
    const remainingMs = getModelCooldownRemainingMs(key, now);
    if (remainingMs > 0) {
      const nextCandidate = candidates[i + 1];
      if (nextCandidate) {
        logCooldownSwitch({
          fromProvider: candidate.provider,
          fromModel: candidate.model,
          toProvider: nextCandidate.provider,
          toModel: nextCandidate.model,
          reason: "cooldown",
          cooldownRemainingMs: remainingMs,
        });
      } else {
        logCooldownNoFallback({
          provider: candidate.provider,
          model: candidate.model,
          cooldownRemainingMs: remainingMs,
        });
      }

      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: `Model ${candidate.provider}/${candidate.model} is in cooldown`,
        reason: "rate_limit",
      });
      continue;
    }

    if (authStore) {
      const profileIds = resolveAuthProfileOrder({
        cfg: params.cfg,
        store: authStore,
        provider: candidate.provider,
      });
      const isAnyProfileAvailable = profileIds.some((id) => !isProfileInCooldown(authStore, id));

      if (profileIds.length > 0 && !isAnyProfileAvailable) {
        // All profiles for this provider are in cooldown; skip without attempting
        const maxCooldownMs = Math.max(
          ...profileIds.map((id) => getProfileCooldownRemainingMs(authStore, id)),
        );

        // Log warning about cooldown switch if there's a next candidate
        const nextCandidate = candidates[i + 1];
        if (nextCandidate) {
          logCooldownSwitch({
            fromProvider: candidate.provider,
            fromModel: candidate.model,
            toProvider: nextCandidate.provider,
            toModel: nextCandidate.model,
            reason: "all_profiles_cooldown",
            cooldownRemainingMs: maxCooldownMs,
          });
        } else {
          // No fallback available
          logCooldownNoFallback({
            provider: candidate.provider,
            model: candidate.model,
            cooldownRemainingMs: maxCooldownMs,
          });
        }

        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          error: `Provider ${candidate.provider} is in cooldown (all profiles unavailable)`,
          reason: "rate_limit",
        });
        continue;
      }

      // Proactive switching: check if any profile is approaching cooldown
      const isApproaching = profileIds.some((id) => isProfileApproachingCooldown(authStore, id));
      if (isApproaching && i === 0 && candidates.length > 1) {
        const nextCandidate = candidates[1];
        // Check if the next candidate is available
        const nextProfileIds = resolveAuthProfileOrder({
          cfg: params.cfg,
          store: authStore,
          provider: nextCandidate.provider,
        });
        const isNextAvailable =
          nextProfileIds.length === 0 ||
          nextProfileIds.some((id) => !isProfileInCooldown(authStore, id));

        if (isNextAvailable) {
          logCooldownSwitch({
            fromProvider: candidate.provider,
            fromModel: candidate.model,
            toProvider: nextCandidate.provider,
            toModel: nextCandidate.model,
            reason: "approaching_cooldown",
          });
          // Skip to the next candidate proactively
          continue;
        }
      }
    }

    // Circuit-breaker: skip provider when open, but if this is the final
    // candidate, force one probe attempt to avoid a hard lock on stale state.
    const breaker = getProviderBreaker(candidate.provider);
    let forceProbeOnLastCandidate = false;
    if (breaker.state() === "open") {
      try {
        // Probe will throw CircuitBreakerOpenError if timeout hasn't elapsed
        await breaker.execute(() => Promise.resolve());
      } catch (err) {
        if (err instanceof CircuitBreakerOpenError) {
          if (i === candidates.length - 1) {
            breaker.reset();
            forceProbeOnLastCandidate = true;
          } else {
            attempts.push({
              provider: candidate.provider,
              model: candidate.model,
              error: `Provider ${candidate.provider} circuit breaker open`,
              reason: "rate_limit",
            });
            continue;
          }
        }
      }
    }

    if (forceProbeOnLastCandidate) {
      console.warn(
        `\x1b[33m[model-fallback]\x1b[0m \x1b[33mProvider ${candidate.provider} breaker was open on last candidate. Forcing probe attempt with ${candidate.provider}/${candidate.model}.\x1b[0m`,
      );
    }

    try {
      const result = await breaker.execute(() => params.run(candidate.provider, candidate.model));
      recordModelSuccess(candidate.provider, candidate.model);
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      if (err instanceof CircuitBreakerOpenError) {
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          error: `Provider ${candidate.provider} circuit breaker open`,
          reason: "rate_limit",
        });
        continue;
      }
      if (shouldRethrowAbort(err)) {
        throw err;
      }
      const normalized =
        coerceToFailoverError(err, {
          provider: candidate.provider,
          model: candidate.model,
        }) ?? err;
      if (!isFailoverError(normalized)) {
        throw err;
      }

      lastError = normalized;
      const described = describeFailoverError(normalized);
      if (described.reason && shouldModelEnterCooldown(described.reason)) {
        recordModelFailure({
          provider: candidate.provider,
          model: candidate.model,
          reason: described.reason,
          errorMessage: described.message,
        });
      }
      attempts.push({
        provider: candidate.provider,
        model: candidate.model,
        error: described.message,
        reason: described.reason,
        status: described.status,
        code: described.code,
      });
      await params.onError?.({
        provider: candidate.provider,
        model: candidate.model,
        error: normalized,
        attempt: i + 1,
        total: candidates.length,
      });

      // Log warning about switching to next model due to error
      const nextCandidate = candidates[i + 1];
      if (nextCandidate) {
        const reasonMsg =
          described.reason === "rate_limit"
            ? "rate limited"
            : described.reason === "billing"
              ? "billing issue"
              : described.reason === "auth"
                ? "authentication error"
                : "error";
        console.warn(
          `\x1b[33m[model-fallback]\x1b[0m \x1b[33mModel ${candidate.provider}/${candidate.model} ${reasonMsg}. Switching to ${nextCandidate.provider}/${nextCandidate.model}.\x1b[0m`,
        );
      }
    }
  }

  if (attempts.length <= 1 && lastError) {
    throw lastError;
  }
  const summary =
    attempts.length > 0
      ? attempts
          .map(
            (attempt) =>
              `${attempt.provider}/${attempt.model}: ${attempt.error}${
                attempt.reason ? ` (${attempt.reason})` : ""
              }`,
          )
          .join(" | ")
      : "unknown";
  throw new Error(`All models failed (${attempts.length || candidates.length}): ${summary}`, {
    cause: lastError instanceof Error ? lastError : undefined,
  });
}

export async function runWithModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  provider: string;
  model: string;
  agentDir?: string;
  /** Optional explicit fallbacks list; when provided (even empty), replaces agents.defaults.model.fallbacks. */
  fallbacksOverride?: string[];
  run: (provider: string, model: string) => Promise<T>;
  onError?: (attempt: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
  }) => void | Promise<void>;
}): Promise<{
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}> {
  const candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
  });
  return runWithCandidates({
    cfg: params.cfg,
    agentDir: params.agentDir,
    candidates,
    run: params.run,
    onError: params.onError,
  });
}

export async function runWithImageModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: (attempt: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
  }) => void | Promise<void>;
}): Promise<{
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}> {
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
  return runWithCandidates({
    cfg: params.cfg,
    candidates,
    run: params.run,
    onError: params.onError,
  });
}

export async function runWithCodingModelFallback<T>(params: {
  cfg: OpenClawConfig | undefined;
  modelOverride?: string;
  run: (provider: string, model: string) => Promise<T>;
  onError?: (attempt: {
    provider: string;
    model: string;
    error: unknown;
    attempt: number;
    total: number;
  }) => void | Promise<void>;
}): Promise<{
  result: T;
  provider: string;
  model: string;
  attempts: FallbackAttempt[];
}> {
  const candidates = resolveCodingFallbackCandidates({
    cfg: params.cfg,
    defaultProvider: DEFAULT_PROVIDER,
    modelOverride: params.modelOverride,
  });

  // If no coding-specific models configured, fall back to default model fallback
  if (candidates.length === 0) {
    const primary = params.cfg
      ? resolveConfiguredModelRef({
          cfg: params.cfg,
          defaultProvider: DEFAULT_PROVIDER,
          defaultModel: DEFAULT_MODEL,
        })
      : { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };

    return runWithModelFallback({
      cfg: params.cfg,
      provider: primary.provider,
      model: primary.model,
      run: params.run,
      onError: params.onError,
    });
  }
  return runWithCandidates({
    cfg: params.cfg,
    candidates,
    run: params.run,
    onError: params.onError,
  });
}
