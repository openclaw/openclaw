/**
 * Single source of truth for pre-transport candidate eligibility facts.
 *
 * Both the fallback runner (for the candidate it is about to attempt) and the
 * route circuit gate (when judging whether a later candidate could actually
 * serve the turn) must agree on these facts. Deriving them twice is how the
 * two paths drifted: the gate previously queried the session skip cache
 * without an auth scope and ordered auth profiles without `forModel`, so a
 * marker for one profile could make a perfectly usable fallback look blocked.
 */
import type { OpenClawConfig } from "../config/config.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isFallbackCandidateSkipped } from "./fallback-skip-cache.js";
import type {
  CandidatePreTransportReadiness,
  ModelFallbackAuthRuntime,
} from "./model-fallback-attempt.js";
import {
  resolveCandidatePreTransportReadiness,
  resolveFallbackAuthScope,
} from "./model-fallback-attempt.js";
import type { ModelFallbackCandidate } from "./model-fallback.types.js";

type CandidateAuthFacts = {
  /** Every ordered profile for the provider, used for subscription reprobes. */
  orderedProfileIds: string[] | undefined;
  /** Profiles subject to provider auth cooldown; unset when the route owns its auth. */
  profileIds: string[] | undefined;
  /** Scope used to key the session skip cache. */
  authScope: string | undefined;
};

/**
 * Resolves auth profile order and skip-cache scope for one candidate.
 *
 * Read-only on purpose: the circuit gate calls this for candidates it only
 * inspects. The runner performs the mutating subscription reprobe itself with
 * `orderedProfileIds` right before it attempts the candidate.
 */
export function resolveCandidateAuthFacts(params: {
  cfg: OpenClawConfig | undefined;
  authRuntime: ModelFallbackAuthRuntime | null;
  authStore: AuthProfileStore | null;
  candidate: ModelFallbackCandidate;
  userLockedAuthProfileId?: string;
  skipsProviderAuthCooldown: boolean;
}): CandidateAuthFacts {
  const { authRuntime, authStore, candidate, userLockedAuthProfileId } = params;
  if (!authRuntime || !authStore) {
    return { orderedProfileIds: undefined, profileIds: undefined, authScope: undefined };
  }
  const userLockedEligible =
    userLockedAuthProfileId !== undefined &&
    authRuntime.resolveAuthProfileEligibility({
      cfg: params.cfg,
      store: authStore,
      provider: candidate.provider,
      profileId: userLockedAuthProfileId,
      includePendingOAuthRefresh: true,
    }).eligible;
  let orderedProfileIds = authRuntime.resolveAuthProfileOrder({
    cfg: params.cfg,
    store: authStore,
    provider: candidate.provider,
    forModel: candidate.model,
    includePendingOAuthRefresh: true,
  });
  if (userLockedEligible && userLockedAuthProfileId) {
    orderedProfileIds = [...new Set([userLockedAuthProfileId, ...orderedProfileIds])];
  }
  const profileIds = params.skipsProviderAuthCooldown ? undefined : orderedProfileIds;
  return {
    orderedProfileIds,
    profileIds,
    authScope: resolveFallbackAuthScope({
      userLockedAuthProfileId: userLockedEligible ? userLockedAuthProfileId : undefined,
      profileIds,
    }),
  };
}

/**
 * Facts for the candidate the runner is about to attempt. Adds the mutating
 * subscription reprobe, which only the attempting path may run.
 */
export async function resolveAttemptAuthFacts(
  params: Parameters<typeof resolveCandidateAuthFacts>[0] & { agentDir?: string },
): Promise<CandidateAuthFacts & { quotaRequiresAuthPreparation: boolean }> {
  const facts = resolveCandidateAuthFacts(params);
  const { authRuntime, authStore } = params;
  if (!authRuntime || !authStore || !facts.orderedProfileIds) {
    return { ...facts, quotaRequiresAuthPreparation: false };
  }
  const quota = await authRuntime.maybeReprobeWhamBlockedProfiles({
    store: authStore,
    profileIds: facts.orderedProfileIds,
    agentDir: params.agentDir,
    cfg: params.cfg,
    forModel: params.candidate.model,
  });
  // Normal auth selection owns remaining profiles and declared direct credentials.
  return { ...facts, quotaRequiresAuthPreparation: quota?.requiresAuthPreparation === true };
}

/**
 * Session skip-cache lookup. The cache keys on
 * `(sessionId, provider, model, authScope)`, so the scope must be supplied or
 * a marker recorded for one profile answers for every profile.
 */
export function isCandidateSessionSkipped(params: {
  sessionId?: string;
  candidate: ModelFallbackCandidate;
  authScope?: string;
  isPrimary: boolean;
}): boolean {
  // The requested route is never skipped from cache: the user asked for it, so
  // surface its real error instead of silently routing past it.
  if (params.isPrimary || !params.sessionId) {
    return false;
  }
  return isFallbackCandidateSkipped({
    sessionId: params.sessionId,
    provider: params.candidate.provider,
    model: params.candidate.model,
    authScope: params.authScope,
  });
}

/**
 * Pre-transport readiness for a candidate the caller is only inspecting.
 *
 * The runner awaits the full harness auth precheck before attempting a
 * candidate, but that precheck can prepare a harness runtime, which mutates
 * state and can throw. The circuit gate inspects later candidates
 * speculatively, so it uses the shared non-mutating prefix instead.
 *
 * Two failure modes matter here and they pull in opposite directions. Calling
 * an unverified harness route runnable lets the gate skip an open primary for
 * a route that dies before transport, which is the zero-attempt outcome the
 * circuit exists to prevent. Calling a direct CLI route unavailable is the
 * mirror image: the runner deliberately lets CLI routes bypass stale provider
 * auth cooldowns, so treating them as blocked sends the turn back to the
 * degraded primary instead of a fallback that would have worked.
 */
export function resolveCandidateTransportReadiness(params: {
  cfg: OpenClawConfig | undefined;
  candidate: ModelFallbackCandidate;
  agentId?: string;
  sessionKey?: string;
  resolveAgentHarnessRuntimeOverride?: (provider: string, model: string) => string | undefined;
}): CandidatePreTransportReadiness {
  return resolveCandidatePreTransportReadiness({
    cfg: params.cfg,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    resolveAgentHarnessRuntimeOverride: params.resolveAgentHarnessRuntimeOverride,
    provider: params.candidate.provider,
    model: params.candidate.model,
  });
}
