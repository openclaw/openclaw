import type { OpenClawConfig } from "../config/config.js";
import { sleep } from "../utils.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import {
  ensureAuthProfileStore,
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
  buildConfiguredAllowlistKeys,
  buildModelAliasIndex,
  modelKey,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";

/**
 * Maximum number of retry rounds when all fallback candidates fail with rate_limit.
 * Each round waits progressively longer before retrying the full candidate list.
 */
const RATE_LIMIT_MAX_RETRIES = 2;

/**
 * Base delay (ms) for 429 retry backoff.  Actual delay = base × 2^(round-1),
 * i.e. 15 s → 30 s for the default 2-round cap.
 */
const RATE_LIMIT_RETRY_BASE_DELAY_MS = 15_000;

/**
 * Hard ceiling for any single retry delay to prevent unbounded waits.
 */
const RATE_LIMIT_RETRY_MAX_DELAY_MS = 60_000;

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
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider,
  });
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
  /** @internal – override for testing */
  _rateLimitRetryDelayMs?: number;
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
  const authStore = params.cfg
    ? ensureAuthProfileStore(params.agentDir, { allowKeychainPrompt: false })
    : null;

  const baseDelay = params._rateLimitRetryDelayMs ?? RATE_LIMIT_RETRY_BASE_DELAY_MS;

  for (let retryRound = 0; ; retryRound += 1) {
    const attempts: FallbackAttempt[] = [];
    let lastError: unknown;
    let actuallyRan = 0;

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
          attempts.push({
            provider: candidate.provider,
            model: candidate.model,
            error: `Provider ${candidate.provider} is in cooldown (all profiles unavailable)`,
            reason: "rate_limit",
          });
          continue;
        }
      }
      try {
        actuallyRan += 1;
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
      }
    }

    // ── 429 retry-with-backoff ──────────────────────────────────────────
    // When every attempt failed due to rate_limit (or was skipped because
    // the provider was already in cooldown) AND at least one candidate
    // actually ran, wait and retry the full candidate list.  This handles
    // the common single-provider scenario where all fallbacks share the
    // same auth profile and a single 429 puts them all in cooldown.
    const allRateLimit =
      attempts.length > 0 && attempts.every((a) => a.reason === "rate_limit");

    if (allRateLimit && retryRound < RATE_LIMIT_MAX_RETRIES) {
      const delay = Math.min(baseDelay * 2 ** retryRound, RATE_LIMIT_RETRY_MAX_DELAY_MS);

      // Log so we can verify retry behaviour in production
      const logMsg = `[model-fallback] 429 retry: round ${retryRound + 1}/${RATE_LIMIT_MAX_RETRIES}, waiting ${(delay / 1000).toFixed(0)}s before retrying ${candidates.length} candidates`;
      if (typeof globalThis.console?.warn === "function") {
        console.warn(logMsg);
      }

      await sleep(delay);

      // Temporarily lift cooldowns so the next round actually attempts
      // the providers again instead of immediately skipping them.
      if (authStore) {
        for (const candidate of candidates) {
          const profileIds = resolveAuthProfileOrder({
            cfg: params.cfg,
            store: authStore,
            provider: candidate.provider,
          });
          for (const id of profileIds) {
            const stats = authStore.usageStats?.[id];
            if (stats?.cooldownUntil) {
              stats.cooldownUntil = undefined;
            }
          }
        }
      }
      continue; // retry the full candidate list
    }

    // ── Terminal failure ────────────────────────────────────────────────
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
