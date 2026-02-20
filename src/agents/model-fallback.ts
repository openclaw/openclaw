import type { OpenClawConfig } from "../config/config.js";
import type { FailoverReason } from "./pi-embedded-helpers.js";
import { sleep } from "../utils.js";
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
  normalizeModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection.js";
import { isLikelyContextOverflowError } from "./pi-embedded-helpers.js";

/**
 * Maximum number of retry rounds when all fallback candidates fail with a
 * retryable reason (rate_limit, timeout, or unknown — the latter two cover
 * Antigravity-style proxies that hang instead of returning 429).
 * Each round waits progressively longer before retrying the full candidate list.
 */
const RATE_LIMIT_MAX_RETRIES = 2;

/**
 * Reasons that qualify for automatic retry-with-backoff.
 * - rate_limit: explicit 429 / cooldown skip
 * - timeout:    request hung (commonly a silent rate limit from proxies)
 * - unknown:    no classifiable reason — often a timeout with empty error body
 */
const RETRYABLE_REASONS = new Set<string>(["rate_limit", "timeout", "unknown"]);

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

function createModelCandidateCollector(allowlist: Set<string> | null | undefined): {
  candidates: ModelCandidate[];
  addCandidate: (candidate: ModelCandidate, enforceAllowlist: boolean) => void;
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

  return { candidates, addCandidate };
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
  const { candidates, addCandidate } = createModelCandidateCollector(allowlist);

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
  const providerRaw = String(params.provider ?? "").trim() || defaultProvider;
  const modelRaw = String(params.model ?? "").trim() || defaultModel;
  const normalizedPrimary = normalizeModelRef(providerRaw, modelRaw);
  const aliasIndex = buildModelAliasIndex({
    cfg: params.cfg ?? {},
    defaultProvider,
  });
  const allowlist = buildConfiguredAllowlistKeys({
    cfg: params.cfg,
    defaultProvider,
  });
  const { candidates, addCandidate } = createModelCandidateCollector(allowlist);

  addCandidate(normalizedPrimary, false);

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
  const baseDelay = RATE_LIMIT_RETRY_BASE_DELAY_MS;

  for (let retryRound = 0; ; retryRound += 1) {
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

    // ── Retryable-failure backoff ────────────────────────────────────────
    // When every attempt failed with a retryable reason (rate_limit,
    // timeout, or unknown), wait and retry the full candidate list.
    // This handles the common single-provider scenario where all fallbacks
    // share the same auth profile and a single 429 (or silent hang that
    // manifests as timeout/unknown) puts them all in cooldown.
    const allRetryable =
      attempts.length > 0 && attempts.every((a) => RETRYABLE_REASONS.has(a.reason ?? "unknown"));

    if (allRetryable && retryRound < RATE_LIMIT_MAX_RETRIES) {
      const delay = Math.min(baseDelay * 2 ** retryRound, RATE_LIMIT_RETRY_MAX_DELAY_MS);

      // Log so we can verify retry behaviour in production
      const reasons = [...new Set(attempts.map((a) => a.reason ?? "unknown"))].join(",");
      const logMsg = `[model-fallback] retry: round ${retryRound + 1}/${RATE_LIMIT_MAX_RETRIES}, reasons=${reasons}, waiting ${(delay / 1000).toFixed(0)}s before retrying ${candidates.length} candidates`;
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
