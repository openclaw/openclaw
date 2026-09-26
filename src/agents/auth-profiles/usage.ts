/**
 * Auth profile usage accounting and cooldown mutation.
 * Records failures under the store lock, applies WHAM usage probes for Codex
 * subscription OAuth profiles, and exposes display helpers for unavailable profiles.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  asDateTimestampMs,
  isFutureDateTimestampMs,
  positiveSecondsToSafeMilliseconds,
  resolveExpiresAtMsFromEpochSeconds,
} from "@openclaw/normalization-core/number-coercion";
import { z } from "zod";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { cancelUnreadResponseBody } from "../../infra/http-body.js";
import { sqlitePrimaryResultCode } from "../../infra/sqlite-error-diagnostics.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveProviderModelAuthPolicy } from "../model-auth-policy.js";
import { readProviderJsonResponse } from "../provider-http-errors.js";
import { resolveProviderRequestHeaders } from "../provider-request-config.js";
import { persistInlineAuthFailure } from "./inline-usage.js";
import { isSettledOAuthRefreshFailure } from "./oauth-refresh-failure.js";
import { resolveAuthProfileOrder } from "./order.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import { logAuthProfileFailureStateChange } from "./state-observation.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import { applyScopedAuthReadThrough, resolvePersistedAuthProfileOwnerAgentDir } from "./store.js";
import type {
  AuthProfileBlockedSource,
  AuthProfileCooldownClassification,
  AuthProfileCredential,
  AuthProfileFailureReason,
  AuthProfileStore,
  OAuthCredential,
  ProfileUsageStats,
} from "./types.js";
import { computeNextProfileUsageStats, resolveUsageWindowUntil } from "./usage-failure-state.js";
import {
  authProfileUsageDeps,
  logDroppedAuthProfileBookkeeping,
  updateOwnedAuthProfileUsage,
} from "./usage-owner-write.js";
import {
  isActiveUnusableWindow,
  isAuthCooldownBypassedForProvider,
  isBlockedWindowActiveForModel,
  isCooldownScopedToDifferentModel,
  resolveInlineProviderApiKeyUsageId,
} from "./usage-state.js";

const authProfileUsageLog = createSubsystemLogger("agent/embedded");
export {
  clearExpiredCooldowns,
  getSoonestCooldownExpiry,
  isProfileInCooldown,
  resolveInlineProviderApiKeyUsageId,
  resolveProfilesUnavailableReason,
  resolveProfileUnusableUntilForDisplay,
} from "./usage-state.js";

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

const WHAM_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
const WHAM_TIMEOUT_MS = 3_000;
const WHAM_BURST_COOLDOWN_MS = 15_000;
const WHAM_PROBE_FAILURE_COOLDOWN_MS = 30_000;
const WHAM_HTTP_ERROR_COOLDOWN_MS = 5 * 60 * 1000;
const WHAM_TOKEN_EXPIRED_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const WHAM_DEAD_ACCOUNT_COOLDOWN_MS = 24 * 60 * 60 * 1000;
const WHAM_HALF_OPEN_REPROBE_INTERVAL_MS = 5 * 60 * 1000;
type WhamReprobeResult = { requiresAuthPreparation: true } | undefined;

const whamReprobesInFlight = new Map<string, Promise<WhamReprobeResult>>();

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

function isWhamOAuthProfile(
  profile: AuthProfileCredential | undefined,
): profile is OAuthCredential {
  return (
    profile?.type === "oauth" &&
    Boolean(profile.access) &&
    normalizeProviderId(profile.provider) === "openai" &&
    resolveProviderModelAuthPolicy({
      provider: profile.provider,
      mode: profile.type,
      authFlow: profile.authFlow,
    }).authRequirement === "subscription"
  );
}

function shouldProbeWhamForFailure(
  profile: AuthProfileCredential | undefined,
  reason: AuthProfileFailureReason,
): profile is OAuthCredential {
  return (
    isWhamOAuthProfile(profile) &&
    // Expired access tokens are routine and refreshable; probing with one
    // guarantees a 401 that looks like a 12h token-family outage.
    isFutureDateTimestampMs(profile.expires) &&
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
    !isWhamOAuthProfile(profile)
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
  cfg?: OpenClawConfig;
  forModel?: string;
  expectedProfile: OAuthCredential;
  startedAt: number;
}): Promise<WhamReprobeResult> {
  const expectedGeneration = structuredClone(params.store.usageStats?.[params.profileId]);
  let expectedProfile = params.expectedProfile;
  if (!isFutureDateTimestampMs(expectedProfile.expires)) {
    // A due quota check may outlive its bearer. The credential owner renews it;
    // only a fresh usage observation can release the unchanged subscription block.
    const { resolveApiKeyForProfile } = await import("./oauth.js");
    const resolved = await resolveApiKeyForProfile({
      store: params.store,
      profileId: params.profileId,
      agentDir: params.agentDir,
      cfg: params.cfg,
      allowProfileFallback: false,
    });
    if (!shouldProbeWhamForFailure(resolved?.credential, "rate_limit")) {
      return { requiresAuthPreparation: true };
    }
    expectedProfile = resolved.credential;
  }
  let didClaim = false;
  const claimed = await updateOwnedAuthProfileUsage(params.store, params.profileId, {
    agentDir: params.agentDir,
    updater: (freshStore) => {
      const currentProfile = freshStore.profiles[params.profileId];
      const currentStats = freshStore.usageStats?.[params.profileId];
      if (
        !currentStats ||
        !matchesWhamBlockGeneration(currentStats, expectedGeneration) ||
        !isSameWhamCredential(expectedProfile, currentProfile) ||
        !shouldProbeWhamForFailure(currentProfile, "rate_limit") ||
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
    return undefined;
  }
  const blockGeneration = structuredClone(claimedStats);
  const result = await probeWhamForCooldown(expectedProfile, params.profileId);
  if (!result.available && !result.blockedUntil) {
    return undefined;
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
        !isSameWhamCredential(expectedProfile, currentProfile)
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
  return undefined;
}

/** Reconciles subscription blocks before the caller decides whether to admit a turn. */
export async function maybeReprobeWhamBlockedProfiles(params: {
  store: AuthProfileStore;
  profileIds: string[];
  agentDir?: string;
  cfg?: OpenClawConfig;
  forModel?: string;
  now?: number;
}): Promise<WhamReprobeResult> {
  const now = params.now ?? Date.now();
  const results = await Promise.allSettled(
    params.profileIds.map(async (profileId) => {
      const shouldProbe = shouldHalfOpenProbeWhamBlock({ ...params, profileId, now });
      if (!shouldProbe && whamReprobesInFlight.size === 0) {
        return undefined;
      }
      const profile = params.store.profiles[profileId];
      if (!isWhamOAuthProfile(profile)) {
        return undefined;
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
          return undefined;
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
            return undefined;
          })
          .finally(() => {
            whamReprobesInFlight.delete(probeKey);
          });
        whamReprobesInFlight.set(probeKey, task);
      }
      let outcome: WhamReprobeResult;
      try {
        outcome = await task;
      } catch (error) {
        if (!isSettledOAuthRefreshFailure(error)) {
          throw error;
        }
        authProfileUsageLog.debug("Quota credential refresh failed before auth preparation", {
          error: formatErrorMessage(error),
        });
        outcome = { requiresAuthPreparation: true };
      }
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
      return outcome;
    }),
  );
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
  // Join peer work before reporting failure. Storage, admission and incomplete
  // refresh cleanup cannot authorize another account or model attempt.
  if (failures.length > 0) {
    throw failures.length === 1
      ? failures[0]
      : new AggregateError(failures, "Quota reconciliation failed", { cause: failures[0] });
  }
  // Both failed refreshes and unavailable credentials belong to normal auth
  // selection. Neither a stale profile list nor quota state can replace it.
  return results.some((result) => result.status === "fulfilled" && result.value)
    ? { requiresAuthPreparation: true }
    : undefined;
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
    cfg: params.config,
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
  // Only Codex subscription OAuth can disambiguate it with the canonical WHAM probe.
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
      freshStore.usageStats ??= {};
      freshStore.usageStats[profileId] = nextStats;
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
      freshStore.usageStats ??= {};
      freshStore.usageStats[profileId] = nextStats;
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
  agentDir: string;
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

  const receipt = await persistInlineAuthFailure(agentDir, { provider, reason, modelId });
  if (receipt) {
    store.usageStats = applyScopedAuthReadThrough(receipt.store).usageStats;
    logAuthProfileFailureStateChange({
      runId,
      profileId: usageId,
      provider,
      reason,
      previous: receipt.previousStats,
      next: receipt.nextStats,
      now: receipt.now,
    });
    return;
  }
  logDroppedAuthProfileBookkeeping("inline_api_key_failure", usageId);
}

/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
