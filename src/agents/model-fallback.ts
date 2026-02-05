import type { OpenClawConfig } from "../config/config.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
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

type ModelCandidate = {
  provider: string;
  model: string;
};

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
  if (ms <= 0) return "0s";
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

  if (params.modelOverride?.trim()) {
    addRaw(params.modelOverride, false);
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
  let candidates = resolveFallbackCandidates({
    cfg: params.cfg,
    provider: params.provider,
    model: params.model,
    fallbacksOverride: params.fallbacksOverride,
  });
  const authStore = params.cfg
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;

  // Sort non-primary candidates by provider health so healthy providers are tried first.
  if (authStore && candidates.length > 2) {
    const [primary, ...tail] = candidates;

    const healthScore = (c: ModelCandidate): number => {
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

    tail.sort((a, b) => healthScore(a) - healthScore(b));
    candidates = [primary, ...tail];
  }

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
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
    try {
      const result = await params.run(candidate.provider, candidate.model);
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
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

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const result = await params.run(candidate.provider, candidate.model);
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      if (shouldRethrowAbort(err)) {
        throw err;
      }
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

  if (attempts.length <= 1 && lastError) {
    throw lastError;
  }
  const summary =
    attempts.length > 0
      ? attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`)
          .join(" | ")
      : "unknown";
  throw new Error(`All image models failed (${attempts.length || candidates.length}): ${summary}`, {
    cause: lastError instanceof Error ? lastError : undefined,
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

  const attempts: FallbackAttempt[] = [];
  let lastError: unknown;

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    try {
      const result = await params.run(candidate.provider, candidate.model);
      return {
        result,
        provider: candidate.provider,
        model: candidate.model,
        attempts,
      };
    } catch (err) {
      if (shouldRethrowAbort(err)) {
        throw err;
      }
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

  if (attempts.length <= 1 && lastError) {
    throw lastError;
  }
  const summary =
    attempts.length > 0
      ? attempts
          .map((attempt) => `${attempt.provider}/${attempt.model}: ${attempt.error}`)
          .join(" | ")
      : "unknown";
  throw new Error(
    `All coding models failed (${attempts.length || candidates.length}): ${summary}`,
    {
      cause: lastError instanceof Error ? lastError : undefined,
    },
  );
}
