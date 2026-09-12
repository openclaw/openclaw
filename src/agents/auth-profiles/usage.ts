/**
 * Auth profile usage accounting and cooldown mutation.
 * Records failures under the store lock, applies WHAM usage probes for OpenAI
 * OAuth profiles, and exposes display helpers for unavailable profiles.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromDurationMs,
  resolveExpiresAtMsFromEpochSeconds,
} from "@openclaw/normalization-core/number-coercion";
import { z } from "zod";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { cancelUnreadResponseBody } from "../../infra/http-body.js";
import { sqlitePrimaryResultCode } from "../../infra/sqlite-error-diagnostics.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { readProviderJsonResponse } from "../provider-http-errors.js";
import { resolveProviderRequestHeaders } from "../provider-request-config.js";
import { resolveAuthProfileOrder } from "./order.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { logAuthProfileFailureStateChange } from "./state-observation.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import { resolvePersistedAuthProfileOwnerAgentDir } from "./store.js";
import type {
  AuthProfileBlockedSource,
  AuthProfileCooldownClassification,
  AuthProfileCredential,
  AuthProfileFailureReason,
  AuthProfileStore,
  OAuthCredential,
  ProfileUsageStats,
} from "./types.js";
import {
  isActiveUnusableWindow,
  isAuthCooldownBypassedForProvider,
  isBlockedWindowActiveForModel,
  isCooldownScopedToDifferentModel,
  isModelScopedCooldownReason,
  resolveInlineProviderApiKeyUsageId,
  resolveProfileUnusableUntil,
} from "./usage-state.js";

const authProfileUsageLog = createSubsystemLogger("agent/embedded");
export {
  clearExpiredCooldowns,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveInlineProviderApiKeyUsageId,
} from "./usage-state.js";

const authProfileUsageDeps = {
  updateAuthProfileStoreWithLock,
};

/** Test-only dependency injection for usage persistence hooks. */
const testing = {
  setDepsForTest(
    overrides: Partial<{
      updateAuthProfileStoreWithLock: typeof updateAuthProfileStoreWithLock;
    }> | null,
  ) {
    authProfileUsageDeps.updateAuthProfileStoreWithLock =
      overrides?.updateAuthProfileStoreWithLock ?? updateAuthProfileStoreWithLock;
  },
  resetWhamReprobeStateForTest() {
    whamReprobesInFlight.clear();
  },
};
if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[Symbol.for("openclaw.authProfileUsageTestApi")] =
    testing;
}

function logDroppedAuthProfileBookkeeping(kind: string, profileId: string): void {
  authProfileUsageLog.warn("dropped auth profile bookkeeping after locked store update failed", {
    event: "auth_profile_bookkeeping_dropped",
    kind,
    profileId,
    tags: ["auth_profiles", "persistence"],
  });
}

async function updateOwnedAuthProfileUsage(
  store: AuthProfileStore,
  profileId: string,
  update: Parameters<typeof updateAuthProfileStoreWithLock>[0],
) {
  // Inherited credentials exist only in the owner's SQLite store. A child lock
  // cannot persist their health state, so resolve the owner before the write.
  let changed = false;
  const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
    ...update,
    profileId,
    agentDir: resolvePersistedAuthProfileOwnerAgentDir({
      agentDir: update.agentDir,
      profileId,
    }),
    updater: (freshStore) => {
      changed = update.updater(freshStore);
      return changed;
    },
  });
  const usage = changed ? updated?.usageStats?.[profileId] : undefined;
  if (usage) {
    store.usageStats = { ...store.usageStats, [profileId]: usage };
  }
  return updated;
}

const FAILURE_REASON_PRIORITY: AuthProfileFailureReason[] = [
  "auth_permanent",
  "auth",
  "session_expired",
  "billing",
  "format",
  "model_not_found",
  "overloaded",
  "timeout",
  "rate_limit",
  "empty_response",
  "no_error_details",
  "unclassified",
  "unknown",
];
const FAILURE_REASON_SET = new Set<AuthProfileFailureReason>(FAILURE_REASON_PRIORITY);

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WHAM_TIMEOUT_MS = 3_000;
const WHAM_BURST_COOLDOWN_MS = 15_000;
const WHAM_PROBE_FAILURE_COOLDOWN_MS = 30_000;
const WHAM_HTTP_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
const WHAM_TOKEN_EXPIRED_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const WHAM_DEAD_ACCOUNT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const WHAM_HALF_OPEN_REPROBE_INTERVAL_MS = 5 * 60 * 1000;
const whamReprobesInFlight = new Map<string, Promise<void>>();

const whamUsageWindowSchema = z.object({
  used_percent: z.number().optional(),
  reset_at: z.number().optional(),
  reset_after_seconds: z.number().optional(),
});
type WhamUsageWindow = z.infer<typeof whamUsageWindowSchema>;
const whamRateLimitSchema = z.object({
  limit_reached: z.boolean().optional(),
  primary_window: whamUsageWindowSchema.nullish(),
  secondary_window: whamUsageWindowSchema.nullish(),
});
const whamUsageSchema = z.object({
  rate_limit: whamRateLimitSchema,
  additional_rate_limits: z
    .array(z.object({ rate_limit: whamRateLimitSchema.nullish() }))
    .nullish(),
  spend_control: z.object({ reached: z.boolean() }).nullish(),
  rate_limit_reached_type: z
    .object({
      type: z.enum([
        "rate_limit_reached",
        "workspace_owner_credits_depleted",
        "workspace_member_credits_depleted",
        "workspace_owner_usage_limit_reached",
        "workspace_member_usage_limit_reached",
        "unknown",
      ]),
    })
    .nullish(),
});

type WhamCooldownProbeResult = {
  available?: true;
  cooldownMs: number;
  cooldownClassification?: AuthProfileCooldownClassification;
  blockedUntil?: number;
};

function shouldProbeWhamForFailure(
  profile: AuthProfileCredential | undefined,
  reason: AuthProfileFailureReason,
): profile is OAuthCredential {
  return (
    profile?.type === "oauth" &&
    Boolean(profile.access) &&
    // Expired access tokens are routine and refreshable; probing with one
    // guarantees a 401 that looks like a 12h token-family outage.
    isFutureDateTimestampMs(profile.expires) &&
    normalizeProviderId(profile.provider) === "openai" &&
    (reason === "rate_limit" ||
      reason === "empty_response" ||
      reason === "no_error_details" ||
      reason === "unclassified" ||
      reason === "unknown")
  );
}

function isSameWhamCredential(
  expected: AuthProfileCredential,
  current: AuthProfileCredential | undefined,
): boolean {
  return (
    expected.type === "oauth" &&
    current?.type === "oauth" &&
    normalizeProviderId(expected.provider) === normalizeProviderId(current.provider) &&
    expected.access === current.access &&
    expected.accountId === current.accountId
  );
}

function resolveActiveWindowUntil(value: unknown, now: number): number {
  const timestampMs = asDateTimestampMs(value);
  return timestampMs !== undefined && timestampMs > now ? timestampMs : 0;
}

function resolveUsageWindowUntil(now: number, durationMs: number): number {
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return now;
  }
  return (
    resolveExpiresAtMsFromDurationMs(Math.max(1, Math.floor(durationMs)), { nowMs: now }) ?? now
  );
}

function resolveWhamResetMs(window: WhamUsageWindow, now: number): number | null {
  if (window.reset_after_seconds !== undefined && window.reset_after_seconds > 0) {
    return positiveSecondsToSafeMilliseconds(window.reset_after_seconds) ?? null;
  }
  if (window.reset_at !== undefined && window.reset_at > 0) {
    const resetAtMs = resolveExpiresAtMsFromEpochSeconds(window.reset_at);
    return resetAtMs === undefined ? null : Math.max(0, resetAtMs - now);
  }
  return null;
}

function isWhamWindowExhausted(
  window: WhamUsageWindow | null | undefined,
): window is WhamUsageWindow {
  return window?.used_percent !== undefined && window.used_percent >= 100;
}

function applyWhamCooldownResult(params: {
  existing: ProfileUsageStats;
  computed: ProfileUsageStats;
  now: number;
  whamResult: WhamCooldownProbeResult;
}): ProfileUsageStats {
  const existingActiveCooldownUntil = resolveActiveWindowUntil(
    params.existing.cooldownUntil,
    params.now,
  );
  const existingActiveBlockedUntil = resolveActiveWindowUntil(
    params.existing.blockedUntil,
    params.now,
  );
  if (params.whamResult.blockedUntil) {
    return {
      ...params.computed,
      lastProbeAt: params.now,
      blockedUntil: Math.max(existingActiveBlockedUntil, params.whamResult.blockedUntil),
      blockedReason: "subscription_limit",
      blockedSource: "wham",
      blockedModel: undefined,
      blockedScope: undefined,
      cooldownUntil: undefined,
      cooldownReason: undefined,
      cooldownClassification: undefined,
      cooldownModel: undefined,
    };
  }
  const { cooldownClassification } = params.whamResult;
  if (
    !cooldownClassification &&
    !params.whamResult.available &&
    (params.computed.cooldownReason === "rate_limit" ||
      (params.computed.blockedReason === "subscription_limit" &&
        isBlockedWindowActiveForModel(params.computed, params.now)))
  ) {
    // A failed or incomplete probe supplied no authoritative retry deadline.
    // Keep the persisted local backoff instead of replacing it with a fixed delay.
    return {
      ...params.computed,
      lastProbeAt: params.now,
    };
  }
  return {
    ...params.computed,
    lastProbeAt: params.now,
    cooldownUntil: Math.max(
      existingActiveCooldownUntil,
      resolveUsageWindowUntil(params.now, params.whamResult.cooldownMs),
    ),
    cooldownReason: cooldownClassification
      ? cooldownClassification === "wham_token_expired"
        ? "auth"
        : "auth_permanent"
      : params.computed.cooldownReason,
    cooldownClassification,
    cooldownModel: cooldownClassification ? undefined : params.computed.cooldownModel,
  };
}

async function probeWhamForCooldown(
  profile: OAuthCredential,
  profileId: string,
): Promise<WhamCooldownProbeResult> {
  try {
    const version = process.env.OPENCLAW_VERSION?.trim();
    const defaultHeaders: Record<string, string> = {
      Authorization: `Bearer ${profile.access}`,
      Accept: "application/json",
      originator: "openclaw",
      ...(version ? { version } : {}),
      "User-Agent": `openclaw/${version || "dev"}`,
    };
    if (profile.accountId) {
      defaultHeaders["ChatGPT-Account-Id"] = profile.accountId;
    }
    const headers =
      resolveProviderRequestHeaders({
        provider: "openai",
        baseUrl: WHAM_USAGE_URL,
        capability: "other",
        transport: "http",
        defaultHeaders,
      }) ?? defaultHeaders;

    const res = await fetch(WHAM_USAGE_URL, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(WHAM_TIMEOUT_MS),
    });

    if (!res.ok) {
      await cancelUnreadResponseBody(res);
      if (res.status === 401 || res.status === 403) {
        const result =
          res.status === 401
            ? {
                cooldownMs: WHAM_TOKEN_EXPIRED_COOLDOWN_MS,
                cooldownClassification: "wham_token_expired" as const,
              }
            : {
                cooldownMs: WHAM_DEAD_ACCOUNT_COOLDOWN_MS,
                cooldownClassification: "wham_account_dead" as const,
              };
        authProfileUsageLog.warn("WHAM probe classified auth profile unavailable", {
          event: "auth_profile_wham_auth_classification",
          profileId,
          status: res.status,
          cooldownClassification: result.cooldownClassification,
          cooldownMs: result.cooldownMs,
          tags: ["auth_profiles", "provider_probe"],
        });
        return result;
      }
      return { cooldownMs: WHAM_HTTP_ERROR_COOLDOWN_MS };
    }

    const parsed = whamUsageSchema.safeParse(
      await readProviderJsonResponse<unknown>(res, "WHAM usage probe"),
    );
    const failedProbe = { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS };
    if (!parsed.success || parsed.data.spend_control?.reached) {
      return failedProbe;
    }
    const limits = [
      parsed.data.rate_limit,
      ...(parsed.data.additional_rate_limits ?? []).flatMap((entry) =>
        entry.rate_limit ? [entry.rate_limit] : [],
      ),
    ];
    const now = Date.now();
    let resetMs = 0;
    for (const limit of limits) {
      const windows = [limit.primary_window, limit.secondary_window].filter(isWhamWindowExhausted);
      if (limit.limit_reached === false && windows.length === 0) {
        continue;
      }
      // Older personal usage responses identify the reached limit without a percentage.
      if (windows.length === 0 && limit.primary_window && !limit.secondary_window) {
        windows.push(limit.primary_window);
      }
      if (windows.length === 0) {
        return failedProbe;
      }
      for (const window of windows) {
        const remainingMs = resolveWhamResetMs(window, now);
        if (remainingMs === null || remainingMs <= 0) {
          return failedProbe;
        }
        resetMs = Math.max(resetMs, remainingMs);
      }
    }
    const reachedType = parsed.data.rate_limit_reached_type?.type;
    if (resetMs === 0 && reachedType && reachedType !== "unknown") {
      return failedProbe;
    }
    return resetMs > 0
      ? {
          cooldownMs: WHAM_BURST_COOLDOWN_MS,
          blockedUntil: resolveUsageWindowUntil(now, resetMs),
        }
      : { available: true, cooldownMs: WHAM_BURST_COOLDOWN_MS };
  } catch {
    return { cooldownMs: WHAM_PROBE_FAILURE_COOLDOWN_MS };
  }
}

function shouldHalfOpenProbeWhamBlock(params: {
  store: AuthProfileStore;
  profileId: string;
  forModel?: string;
  now: number;
}): boolean {
  const profile = params.store.profiles[params.profileId];
  const stats = params.store.usageStats?.[params.profileId];
  if (
    !stats ||
    stats.blockedReason !== "subscription_limit" ||
    !isBlockedWindowActiveForModel(stats, params.now, params.forModel) ||
    (isActiveUnusableWindow(stats.cooldownUntil, params.now) &&
      !isCooldownScopedToDifferentModel(stats, params.forModel) &&
      !(
        stats.cooldownReason === "rate_limit" &&
        isBlockedWindowActiveForModel(stats, params.now, stats.cooldownModel ?? null)
      )) ||
    isActiveUnusableWindow(stats.disabledUntil, params.now) ||
    !shouldProbeWhamForFailure(profile, "rate_limit")
  ) {
    return false;
  }
  const sinceLastProbeMs = params.now - (stats.lastProbeAt ?? 0);
  return sinceLastProbeMs >= WHAM_HALF_OPEN_REPROBE_INTERVAL_MS;
}

function matchesWhamBlockGeneration(
  stats: ProfileUsageStats | undefined,
  generation: ProfileUsageStats | undefined,
): boolean {
  return (
    stats?.blockedUntil === generation?.blockedUntil &&
    stats?.blockedReason === generation?.blockedReason &&
    stats?.blockedSource === generation?.blockedSource &&
    stats?.blockedModel === generation?.blockedModel &&
    stats?.blockedScope === generation?.blockedScope &&
    stats?.lastProbeAt === generation?.lastProbeAt &&
    stats?.lastFailureAt === generation?.lastFailureAt &&
    stats?.failureCounts?.rate_limit === generation?.failureCounts?.rate_limit
  );
}

function reconcileWhamBlock(
  stats: ProfileUsageStats,
  result: WhamCooldownProbeResult,
  now: number,
): ProfileUsageStats {
  return {
    ...stats,
    blockedUntil: result.blockedUntil,
    blockedReason: result.available ? undefined : "subscription_limit",
    blockedSource: result.available ? undefined : "wham",
    blockedModel: result.available ? undefined : stats.blockedModel,
    blockedScope: result.available ? undefined : stats.blockedScope,
    ...(stats.cooldownReason === "rate_limit" &&
    isBlockedWindowActiveForModel(stats, now, stats.cooldownModel ?? null)
      ? {
          cooldownUntil: undefined,
          cooldownReason: undefined,
          cooldownClassification: undefined,
          cooldownModel: undefined,
        }
      : {}),
  };
}

async function runWhamHalfOpenReprobe(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  forModel?: string;
  expectedProfile: OAuthCredential;
  startedAt: number;
}): Promise<void> {
  let didClaim = false;
  const claimed = await updateOwnedAuthProfileUsage(params.store, params.profileId, {
    agentDir: params.agentDir,
    updater: (freshStore) => {
      const currentProfile = freshStore.profiles[params.profileId];
      const currentStats = freshStore.usageStats?.[params.profileId];
      if (
        !currentStats ||
        !isSameWhamCredential(params.expectedProfile, currentProfile) ||
        !shouldHalfOpenProbeWhamBlock({
          store: freshStore,
          profileId: params.profileId,
          forModel: params.forModel,
          now: params.startedAt,
        })
      ) {
        return false;
      }
      currentStats.lastProbeAt = params.startedAt;
      didClaim = true;
      return true;
    },
  });
  if (claimed === null) {
    logDroppedAuthProfileBookkeeping("wham_half_open_claim", params.profileId);
  }
  const claimedStats = claimed?.usageStats?.[params.profileId];
  if (!didClaim || !claimedStats) {
    return;
  }
  const blockGeneration = structuredClone(claimedStats);
  const result = await probeWhamForCooldown(params.expectedProfile, params.profileId);
  if (!result.available && !result.blockedUntil) {
    return;
  }
  const updated = await updateOwnedAuthProfileUsage(params.store, params.profileId, {
    agentDir: params.agentDir,
    updater: (freshStore) => {
      const currentProfile = freshStore.profiles[params.profileId];
      const currentStats = freshStore.usageStats?.[params.profileId];
      if (
        !currentStats ||
        currentStats.blockedReason !== "subscription_limit" ||
        !matchesWhamBlockGeneration(currentStats, blockGeneration) ||
        !isSameWhamCredential(params.expectedProfile, currentProfile)
      ) {
        return false;
      }
      Object.assign(currentStats, reconcileWhamBlock(currentStats, result, params.startedAt));
      return true;
    },
  });
  if (updated === null) {
    logDroppedAuthProfileBookkeeping("wham_half_open_reprobe", params.profileId);
  }
}

/** Reconciles subscription blocks before the caller decides whether to admit a turn. */
export async function maybeReprobeWhamBlockedProfiles(params: {
  store: AuthProfileStore;
  profileIds: string[];
  agentDir?: string;
  forModel?: string;
  now?: number;
}): Promise<void> {
  const now = params.now ?? Date.now();
  await Promise.all(
    params.profileIds.map(async (profileId) => {
      const shouldProbe = shouldHalfOpenProbeWhamBlock({ ...params, profileId, now });
      if (!shouldProbe && whamReprobesInFlight.size === 0) {
        return;
      }
      const profile = params.store.profiles[profileId];
      if (!shouldProbeWhamForFailure(profile, "rate_limit")) {
        return;
      }
      const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: params.agentDir,
        profileId,
      });
      const ownerPath = ownerAgentDir
        ? resolveAuthProfileDatabasePath(ownerAgentDir)
        : resolveSharedAuthStorePath();
      const probeKey = `${ownerPath}\u0000${profileId}`;
      let task = whamReprobesInFlight.get(probeKey);
      if (!task) {
        if (!shouldProbe) {
          return;
        }
        task = runWhamHalfOpenReprobe({
          ...params,
          profileId,
          expectedProfile: structuredClone(profile),
          startedAt: now,
        })
          .catch((error: unknown) => {
            const code = sqlitePrimaryResultCode(error);
            if (code !== 8 && code !== 10 && code !== 13) {
              throw error;
            }
          })
          .finally(() => {
            whamReprobesInFlight.delete(probeKey);
          });
        whamReprobesInFlight.set(probeKey, task);
      }
      await task;
      // Refresh can rotate a token, and a child can gain its own credential while waiting.
      const settled = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir, { profileId });
      const credential = settled.profiles[profileId];
      if (credential) {
        params.store.profiles[profileId] = credential;
      } else {
        delete params.store.profiles[profileId];
      }
      const usage = settled.usageStats?.[profileId];
      if (usage) {
        params.store.usageStats = { ...params.store.usageStats, [profileId]: usage };
      } else {
        delete params.store.usageStats?.[profileId];
      }
    }),
  );
}

/** Refreshes the selected provider's quota facts before direct runtime admission. */
export async function reconcileAuthProfileQuotaBlocks(params: {
  authProfileStore?: AuthProfileStore;
  provider: string;
  config?: OpenClawConfig;
  agentDir?: string;
  modelId: string;
  sessionAuthProfileId?: string;
  sessionAuthProfileSource?: "auto" | "user" | "user-link";
}): Promise<void> {
  const store = params.authProfileStore;
  if (!store || normalizeProviderId(params.provider) !== "openai") {
    return;
  }
  const lockedProfileId =
    params.sessionAuthProfileSource === "user" || params.sessionAuthProfileSource === "user-link"
      ? params.sessionAuthProfileId
      : undefined;
  await maybeReprobeWhamBlockedProfiles({
    store,
    agentDir: params.agentDir,
    forModel: params.modelId,
    profileIds: lockedProfileId
      ? [lockedProfileId]
      : resolveAuthProfileOrder({
          store,
          cfg: params.config,
          provider: params.provider,
          preferredProfile: params.sessionAuthProfileId,
          forModel: params.modelId,
          includePendingOAuthRefresh: true,
        }),
  });
}

/**
 * Infer the most likely reason all candidate profiles are currently unavailable.
 *
 * We prefer explicit active `disabledReason` values (for example billing/auth)
 * over generic cooldown buckets, then fall back to failure-count signals.
 */
export function resolveProfilesUnavailableReason(params: {
  store: AuthProfileStore;
  profileIds: string[];
  now?: number;
}): AuthProfileFailureReason | null {
  const now = params.now ?? Date.now();
  const scores = new Map<AuthProfileFailureReason, number>();
  const addScore = (reason: AuthProfileFailureReason, value: number) => {
    if (!FAILURE_REASON_SET.has(reason) || value <= 0 || !Number.isFinite(value)) {
      return;
    }
    scores.set(reason, (scores.get(reason) ?? 0) + value);
  };

  for (const profileId of params.profileIds) {
    const stats = params.store.usageStats?.[profileId];
    if (!stats) {
      continue;
    }

    const disabledActive = isActiveUnusableWindow(stats.disabledUntil, now);
    if (disabledActive && stats.disabledReason && FAILURE_REASON_SET.has(stats.disabledReason)) {
      // Disabled reasons are explicit and high-signal; weight heavily.
      addScore(stats.disabledReason, 1_000);
      continue;
    }

    if (isActiveUnusableWindow(stats.blockedUntil, now)) {
      addScore("rate_limit", 1_000);
      continue;
    }

    const cooldownActive = isActiveUnusableWindow(stats.cooldownUntil, now);
    if (!cooldownActive) {
      continue;
    }

    if (stats.cooldownReason && FAILURE_REASON_SET.has(stats.cooldownReason)) {
      addScore(stats.cooldownReason, 1_000);
      continue;
    }

    let recordedReason = false;
    for (const [rawReason, rawCount] of Object.entries(stats.failureCounts ?? {})) {
      const reason = rawReason as AuthProfileFailureReason;
      const count = typeof rawCount === "number" ? rawCount : 0;
      if (!FAILURE_REASON_SET.has(reason) || count <= 0) {
        continue;
      }
      addScore(reason, count);
      recordedReason = true;
    }
    if (!recordedReason) {
      // No failure counts recorded for this cooldown window. Previously this
      // defaulted to "rate_limit", which caused false "rate limit reached"
      // warnings when the actual reason was unknown (e.g. transient network
      // blip or server error without a classified failure count).
      addScore("unknown", 1);
    }
  }

  let best: AuthProfileFailureReason | null = null;
  let bestScore = -1;
  for (const reason of FAILURE_REASON_PRIORITY) {
    const score = scores.get(reason);
    if (score !== undefined && score > bestScore) {
      best = reason;
      bestScore = score;
    }
  }
  return best;
}

/** Returns the regular transient-failure cooldown duration for an error count. */
function calculateAuthProfileCooldownMs(errorCount: number): number {
  const normalized = Math.max(1, errorCount);
  if (normalized <= 1) {
    return 30_000; // 30 seconds
  }
  if (normalized <= 2) {
    return 60_000; // 1 minute
  }
  return 5 * 60_000; // 5 minutes max
}

// Without a provider reset, grow failed half-open probes up to one billing day:
// frequent retries risk metered fallback spend, while a finite cap still retries daily.
const RATE_LIMIT_BACKOFF_BASE_MS = 30_000;
const RATE_LIMIT_BACKOFF_MAX_MS = 24 * 60 * 60 * 1000;

type ResolvedAuthCooldownConfig = {
  billingBackoffMs: number;
  billingMaxMs: number;
  authPermanentBackoffMs: number;
  authPermanentMaxMs: number;
  failureWindowMs: number;
};

type DisabledFailureReason = Extract<AuthProfileFailureReason, "billing" | "auth_permanent">;

type DisabledFailureBackoffPolicy = {
  baseMs: number;
  maxMs: number;
};

// Keep the initial billing disable short so inline API keys can retry soon
// after recharge, even though they cannot probe during an active window.
const AUTH_COOLDOWN_CONFIG: ResolvedAuthCooldownConfig = {
  billingBackoffMs: 10 * 60 * 1000,
  billingMaxMs: 24 * 60 * 60 * 1000,
  authPermanentBackoffMs: 10 * 60 * 1000,
  authPermanentMaxMs: 60 * 60 * 1000,
  failureWindowMs: 24 * 60 * 60 * 1000,
};

const DISABLED_FAILURE_BACKOFF_POLICIES = {
  billing: {
    baseMs: AUTH_COOLDOWN_CONFIG.billingBackoffMs,
    maxMs: AUTH_COOLDOWN_CONFIG.billingMaxMs,
  },
  auth_permanent: {
    // Recover quickly because some providers surface auth-looking payloads
    // transiently during incidents.
    baseMs: AUTH_COOLDOWN_CONFIG.authPermanentBackoffMs,
    maxMs: AUTH_COOLDOWN_CONFIG.authPermanentMaxMs,
  },
} as const satisfies Record<DisabledFailureReason, DisabledFailureBackoffPolicy>;

function calculateCappedExponentialBackoffMs(params: {
  errorCount: number;
  baseMs: number;
  maxMs: number;
}): number {
  const normalized = Math.max(1, params.errorCount);
  const baseMs = Math.max(1, params.baseMs);
  const maxMs = Math.max(baseMs, params.maxMs);
  const maxExponent = Math.max(0, Math.ceil(Math.log2(maxMs / baseMs)));
  const exponent = Math.min(normalized - 1, maxExponent);
  const raw = baseMs * 2 ** exponent;
  return Math.min(maxMs, raw);
}

function resolveDisabledFailureBackoffMs(params: {
  reason: DisabledFailureReason;
  errorCount: number;
}): number {
  return calculateCappedExponentialBackoffMs({
    errorCount: params.errorCount,
    ...DISABLED_FAILURE_BACKOFF_POLICIES[params.reason],
  });
}

/** Resolves the display-facing unusable timestamp, honoring provider bypasses. */
export function resolveProfileUnusableUntilForDisplay(
  store: AuthProfileStore,
  profileId: string,
): number | null {
  if (isAuthCooldownBypassedForProvider(store.profiles[profileId]?.provider)) {
    return null;
  }
  const stats = store.usageStats?.[profileId];
  if (!stats) {
    return null;
  }
  return resolveProfileUnusableUntil(stats);
}

function updateUsageStatsEntry(
  store: AuthProfileStore,
  profileId: string,
  updater: (existing: ProfileUsageStats | undefined) => ProfileUsageStats,
): void {
  store.usageStats = store.usageStats ?? {};
  store.usageStats[profileId] = updater(store.usageStats[profileId]);
}

function keepActiveWindowOrRecompute(params: {
  existingUntil: number | undefined;
  now: number;
  recomputedUntil: number;
}): number {
  const { existingUntil, now, recomputedUntil } = params;
  const hasActiveWindow =
    typeof existingUntil === "number" && Number.isFinite(existingUntil) && existingUntil > now;
  return hasActiveWindow ? existingUntil : recomputedUntil;
}

function computeNextProfileUsageStats(params: {
  existing: ProfileUsageStats;
  now: number;
  reason: AuthProfileFailureReason;
  modelId?: string;
}): ProfileUsageStats {
  // The provider quota writer already recorded this failure and its retry deadline.
  if (
    params.reason === "rate_limit" &&
    params.existing.blockedReason === "subscription_limit" &&
    isBlockedWindowActiveForModel(params.existing, params.now, params.modelId ?? null)
  ) {
    return params.existing;
  }
  const windowMs = AUTH_COOLDOWN_CONFIG.failureWindowMs;
  const windowExpired =
    typeof params.existing.lastFailureAt === "number" &&
    params.existing.lastFailureAt > 0 &&
    params.now - params.existing.lastFailureAt > windowMs;

  // If the previous cooldown has already expired, reset error counters so the
  // profile gets a fresh backoff window. clearExpiredCooldowns() does this
  // in-memory during profile ordering, but the on-disk state may still carry
  // the old counters when the lock-based updater reads a fresh store. Without
  // this check, stale error counts from an expired cooldown cause the next
  // failure to escalate to a much longer cooldown (e.g. 1 min → 25 min).
  const unusableUntil = resolveProfileUnusableUntil(params.existing);
  const previousCooldownExpired = typeof unusableUntil === "number" && params.now >= unusableUntil;

  // A rate-limit profile remains half-open until a real request succeeds. Its
  // dedicated counter survives expiry, while the aggregate counter resets so
  // unrelated failures do not inherit the rate-limit backoff history.
  const shouldResetAggregateCounter = windowExpired || previousCooldownExpired;
  const baseErrorCount = shouldResetAggregateCounter ? 0 : (params.existing.errorCount ?? 0);
  const nextErrorCount = baseErrorCount + 1;
  const preservedRateLimitCount = params.existing.failureCounts?.rate_limit;
  const failureCounts = shouldResetAggregateCounter
    ? preservedRateLimitCount
      ? { rate_limit: preservedRateLimitCount }
      : {}
    : { ...params.existing.failureCounts };
  failureCounts[params.reason] = (failureCounts[params.reason] ?? 0) + 1;

  const updatedStats: ProfileUsageStats = {
    ...params.existing,
    // Exact provider diagnostics describe only the cooldown generation that
    // produced them; every ordinary failure replaces that diagnostic state.
    cooldownClassification: undefined,
    errorCount: nextErrorCount,
    failureCounts,
    lastFailureAt: params.now,
  };

  const disabledFailureReason =
    params.reason === "billing" || params.reason === "auth_permanent" ? params.reason : null;

  if (disabledFailureReason) {
    const disableCount = failureCounts[disabledFailureReason] ?? 1;
    const backoffMs = resolveDisabledFailureBackoffMs({
      reason: disabledFailureReason,
      errorCount: disableCount,
    });
    // Keep active disable windows immutable so retries within the window cannot
    // extend recovery time indefinitely.
    updatedStats.disabledUntil = keepActiveWindowOrRecompute({
      existingUntil: params.existing.disabledUntil,
      now: params.now,
      recomputedUntil: resolveUsageWindowUntil(params.now, backoffMs),
    });
    updatedStats.disabledReason = disabledFailureReason;
  } else {
    const backoffMs =
      params.reason === "rate_limit"
        ? calculateCappedExponentialBackoffMs({
            errorCount: failureCounts.rate_limit ?? 1,
            baseMs: RATE_LIMIT_BACKOFF_BASE_MS,
            maxMs: RATE_LIMIT_BACKOFF_MAX_MS,
          })
        : calculateAuthProfileCooldownMs(nextErrorCount);
    // Keep active cooldown windows immutable so retries within the window
    // cannot push recovery further out.
    updatedStats.cooldownUntil = keepActiveWindowOrRecompute({
      existingUntil: params.existing.cooldownUntil,
      now: params.now,
      recomputedUntil: resolveUsageWindowUntil(params.now, backoffMs),
    });
    // Update cooldown metadata based on whether the window is still active
    // and whether the same or a different model is failing.
    const existingCooldownActive =
      typeof params.existing.cooldownUntil === "number" &&
      params.existing.cooldownUntil > params.now;
    if (existingCooldownActive) {
      // Always use the latest failure reason so that downstream consumers
      // (e.g. isProfileInCooldown model-bypass) see the most recent signal.
      // A non-rate_limit failure (auth, billing, …) is profile-wide, so
      // upgrading from rate_limit → auth correctly blocks all models.
      updatedStats.cooldownReason = params.reason;
      // If a different model fails during an active window, widen the scope
      // to all models (undefined) so neither model bypasses the cooldown.
      if (
        params.existing.cooldownModel &&
        params.modelId &&
        params.existing.cooldownModel !== params.modelId
      ) {
        updatedStats.cooldownModel = undefined;
      } else if (
        isModelScopedCooldownReason(params.reason) &&
        !params.modelId &&
        params.existing.cooldownModel
      ) {
        // Unknown originating model during an active model-scoped cooldown:
        // widen scope conservatively so no model can bypass on stale metadata.
        updatedStats.cooldownModel = undefined;
      } else if (!isModelScopedCooldownReason(params.reason)) {
        // Profile-wide failures (auth, billing, format, server_error, ...) —
        // clear model scope so that no model can bypass.
        updatedStats.cooldownModel = undefined;
      } else {
        updatedStats.cooldownModel = params.existing.cooldownModel;
      }
    } else {
      updatedStats.cooldownReason = params.reason;
      updatedStats.cooldownModel = isModelScopedCooldownReason(params.reason)
        ? params.modelId
        : undefined;
    }
  }

  return updatedStats;
}

/**
 * Mark a profile as failed for a specific reason. Billing and permanent-auth
 * failures are treated as "disabled" (longer backoff) vs the regular cooldown
 * window.
 */
export async function markAuthProfileFailure(params: {
  store: AuthProfileStore;
  profileId: string;
  reason: AuthProfileFailureReason;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runId?: string;
  modelId?: string;
}): Promise<void> {
  const { store, profileId, reason, agentDir, runId, modelId } = params;
  const profile = structuredClone(store.profiles[profileId]);
  if (
    !profile ||
    profile.setup?.replacement ||
    isAuthCooldownBypassedForProvider(profile.provider)
  ) {
    return;
  }

  const shouldProbeWham = shouldProbeWhamForFailure(profile, reason);
  // A detail-less provider failure carries no credential-health evidence.
  // Only OpenAI OAuth can disambiguate it with the canonical WHAM probe.
  if (reason === "no_error_details" && !shouldProbeWham) {
    return;
  }

  const observedStore = shouldProbeWham
    ? loadAuthProfileStoreWithoutExternalProfiles(agentDir, { profileId })
    : undefined;
  const blockGeneration = structuredClone(observedStore?.usageStats?.[profileId]);
  const whamResult = shouldProbeWham ? await probeWhamForCooldown(profile, profileId) : null;

  let nextStats: ProfileUsageStats | undefined;
  let previousStats: ProfileUsageStats | undefined;
  let updateTime = 0;
  const updated = await updateOwnedAuthProfileUsage(store, profileId, {
    agentDir,
    updater: (freshStore) => {
      const profileValue = freshStore.profiles[profileId];
      if (
        !profileValue ||
        profileValue.setup?.replacement ||
        isAuthCooldownBypassedForProvider(profileValue.provider)
      ) {
        return false;
      }
      previousStats = freshStore.usageStats?.[profileId];
      const currentWhamResult =
        whamResult &&
        shouldProbeWhamForFailure(profileValue, reason) &&
        isSameWhamCredential(profile, profileValue) &&
        ((!whamResult.available && !whamResult.blockedUntil) ||
          (observedStore &&
            isSameWhamCredential(profile, observedStore.profiles[profileId]) &&
            matchesWhamBlockGeneration(previousStats, blockGeneration)))
          ? whamResult
          : null;
      // The WHAM response belongs to the credential snapshot used for the
      // probe. A concurrent profile replacement must not inherit its result.
      if (reason === "no_error_details" && !currentWhamResult) {
        return false;
      }
      const now = Date.now();

      updateTime = now;
      const existing =
        currentWhamResult?.available && previousStats?.blockedReason === "subscription_limit"
          ? reconcileWhamBlock(previousStats, currentWhamResult, now)
          : (previousStats ?? {});
      const computed = computeNextProfileUsageStats({
        existing,
        now,
        reason,
        modelId,
      });
      nextStats = currentWhamResult
        ? applyWhamCooldownResult({
            existing,
            computed,
            now,
            whamResult: currentWhamResult,
          })
        : computed;
      updateUsageStatsEntry(freshStore, profileId, () => nextStats ?? computed);
      return true;
    },
  });
  if (updated) {
    if (nextStats) {
      logAuthProfileFailureStateChange({
        runId,
        profileId,
        provider: profile.provider,
        reason,
        previous: previousStats,
        next: nextStats,
        now: updateTime,
      });
    }
    return;
  }
  if (updated === null) {
    logDroppedAuthProfileBookkeeping("failure", profileId);
  }
}

function buildBlockedProfileUsageStats(params: {
  previousStats: ProfileUsageStats | undefined;
  blockedUntil: number;
  source: AuthProfileBlockedSource;
  modelId: string | undefined;
  now: number;
}): ProfileUsageStats {
  const activeBlockedUntil = resolveActiveWindowUntil(
    params.previousStats?.blockedUntil,
    params.now,
  );
  // One active block can stay model-scoped only while every observation names
  // that same model. Mixed or unknown observations widen the profile.
  const blockedModel =
    activeBlockedUntil === 0
      ? params.modelId
      : params.previousStats?.blockedScope === "model" &&
          params.previousStats.blockedModel === params.modelId &&
          params.modelId
        ? params.modelId
        : undefined;
  return {
    ...params.previousStats,
    blockedUntil: Math.max(activeBlockedUntil, params.blockedUntil),
    blockedReason: "subscription_limit",
    blockedSource: params.source,
    blockedModel,
    blockedScope: blockedModel ? "model" : undefined,
    cooldownUntil: undefined,
    cooldownReason: undefined,
    cooldownClassification: undefined,
    cooldownModel: undefined,
    lastFailureAt: params.now,
    failureCounts: {
      ...params.previousStats?.failureCounts,
      rate_limit: (params.previousStats?.failureCounts?.rate_limit ?? 0) + 1,
    },
  };
}

/** Marks a profile blocked until a provider-reported reset timestamp. */
export async function markAuthProfileBlockedUntil(params: {
  store: AuthProfileStore;
  profileId: string;
  blockedUntil: number;
  source: AuthProfileBlockedSource;
  agentDir?: string;
  runId?: string;
  modelId?: string;
}): Promise<void> {
  const { store, profileId, blockedUntil, agentDir, runId, modelId, source } = params;
  const profile = store.profiles[profileId];
  if (
    !profile ||
    isAuthCooldownBypassedForProvider(profile.provider) ||
    !isFutureDateTimestampMs(blockedUntil)
  ) {
    return;
  }

  let nextStats: ProfileUsageStats | undefined;
  let previousStats: ProfileUsageStats | undefined;
  let updateTime = 0;
  const updated = await updateOwnedAuthProfileUsage(store, profileId, {
    agentDir,
    updater: (freshStore) => {
      const profileLocal = freshStore.profiles[profileId];
      if (!profileLocal || isAuthCooldownBypassedForProvider(profileLocal.provider)) {
        return false;
      }
      const now = asDateTimestampMs(Date.now());
      if (now === undefined) {
        return false;
      }
      previousStats = freshStore.usageStats?.[profileId];
      updateTime = now;
      nextStats = buildBlockedProfileUsageStats({
        previousStats,
        blockedUntil,
        source,
        modelId,
        now,
      });
      updateUsageStatsEntry(freshStore, profileId, () => nextStats as ProfileUsageStats);
      return true;
    },
  });
  if (updated) {
    if (nextStats) {
      logAuthProfileFailureStateChange({
        runId,
        profileId,
        provider: profile.provider,
        reason: "rate_limit",
        previous: previousStats,
        next: nextStats,
        now: updateTime,
      });
    }
    return;
  }
  if (updated === null) {
    logDroppedAuthProfileBookkeeping("blocked_until", profileId);
  }
}

export async function markInlineProviderApiKeyFailure(params: {
  store: AuthProfileStore;
  provider: string;
  reason: AuthProfileFailureReason;
  cfg?: OpenClawConfig;
  agentDir?: string;
  runId?: string;
  modelId?: string;
}): Promise<void> {
  const { store, provider, reason, agentDir, runId, modelId } = params;
  if (
    (reason !== "auth" && reason !== "auth_permanent" && reason !== "billing") ||
    isAuthCooldownBypassedForProvider(provider)
  ) {
    return;
  }

  const usageId = resolveInlineProviderApiKeyUsageId(provider);

  let nextStats: ProfileUsageStats | undefined;
  let previousStats: ProfileUsageStats | undefined;
  let updateTime = 0;
  const updated = await authProfileUsageDeps.updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const now = Date.now();
      previousStats = freshStore.usageStats?.[usageId];
      updateTime = now;
      nextStats = computeNextProfileUsageStats({
        existing: previousStats ?? {},
        now,
        reason,
        modelId,
      });
      updateUsageStatsEntry(freshStore, usageId, () => nextStats as ProfileUsageStats);
      return true;
    },
  });
  if (updated) {
    store.usageStats = updated.usageStats;
    if (nextStats) {
      logAuthProfileFailureStateChange({
        runId,
        profileId: usageId,
        provider,
        reason,
        previous: previousStats,
        next: nextStats,
        now: updateTime,
      });
    }
    return;
  }
  if (updated === null) {
    logDroppedAuthProfileBookkeeping("inline_api_key_failure", usageId);
  }
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
