import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AssistantMessage, Model } from "../llm/types.js";
import { getModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { advanceAuthProfileCandidate } from "./auth-profiles/advance.js";
import { markAuthProfileSuccess } from "./auth-profiles/profiles.js";
import type { AuthProfileFailureReason, AuthProfileStore } from "./auth-profiles/types.js";
import { getSoonestCooldownExpiry, isProfileInCooldown } from "./auth-profiles/usage-state.js";
import { markAuthProfileFailure } from "./auth-profiles/usage.js";
import {
  buildAssistantFailoverSignal,
  classifyAssistantFailoverReason,
} from "./embedded-agent-helpers/assistant-message-failures.js";
import { resolveAuthProfileFailureReason } from "./embedded-agent-runner/run/auth-profile-failure-policy.js";
import type { FailoverReason } from "./failover/signal.js";
import type { PreparedSimpleCompletionModel } from "./simple-completion.types.js";

type PreparedModel = Extract<PreparedSimpleCompletionModel, { model: Model }>;

export type SimpleCompletionAuthProfiles = {
  store: AuthProfileStore;
  profileIds: readonly string[];
  prepare(profileId: string, assertCurrent: () => void): Promise<PreparedSimpleCompletionModel>;
};

type SimpleCompletionProfileOutcome = {
  profileId: string;
  reason: AuthProfileFailureReason | "cooldown" | "unavailable" | "not_dispatched";
  status?: number;
  rateLimitResetAt?: number;
};

const MAX_RECORDED_PROFILE_OUTCOMES = 16;

/**
 * A connection that failed before any provider event says nothing about the
 * credential, so its timeout stays out of shared profile health. A WebSocket
 * failure that fell back to another transport describes only that first leg.
 */
function didProviderStart(result: AssistantMessage): boolean {
  const transportFailure = result.diagnostics?.findLast(
    (entry) => entry.type === "provider_transport_failure",
  );
  return !(
    transportFailure?.details?.eventsEmitted === false &&
    transportFailure.details.fallbackTransport === undefined &&
    result.content.length === 0 &&
    !result.responseId
  );
}

/** Adapts one-shot completions to the shared auth planner, health store and candidate cursor. */
export async function completeWithAuthProfileFailover(params: {
  prepared: PreparedModel & { authProfiles?: SimpleCompletionAuthProfiles };
  cfg: OpenClawConfig;
  agentDir: string;
  signal?: AbortSignal;
  assertCurrent: () => void;
  complete(prepared: PreparedModel): Promise<AssistantMessage>;
  canRotate?(result: AssistantMessage, reason: FailoverReason | null): boolean;
  onExhausted?(summary: {
    attempts: readonly SimpleCompletionProfileOutcome[];
    failedProfileCount: number;
    profileCount: number;
  }): void;
  warn(message: string): void;
}): Promise<AssistantMessage> {
  const profiles = params.prepared.authProfiles;
  const attempts: SimpleCompletionProfileOutcome[] = [];
  const record = (outcome: SimpleCompletionProfileOutcome, { dispatched = false } = {}) => {
    if (!params.onExhausted) {
      return;
    }
    if (attempts.length < MAX_RECORDED_PROFILE_OUTCOMES) {
      attempts.push(outcome);
    } else if (dispatched) {
      // Keep the latest provider result visible even after many pre-dispatch skips.
      attempts[MAX_RECORDED_PROFILE_OUTCOMES - 1] = outcome;
    }
  };
  let failedProfileCount = 0;
  let current: PreparedModel = params.prepared;
  const state = { profileIndex: profiles?.profileIds.indexOf(current.auth.profileId ?? "") ?? -1 };
  if (params.onExhausted && profiles && state.profileIndex > 0) {
    // Initial preparation returns its selected profile, without a cause for earlier skips.
    for (const profileId of profiles.profileIds.slice(0, state.profileIndex)) {
      record({ profileId, reason: "not_dispatched" });
    }
  }
  for (;;) {
    params.assertCurrent();
    const result = await params.complete(current);
    params.assertCurrent();
    if (params.signal?.aborted) {
      return result;
    }
    const failoverReason = classifyAssistantFailoverReason(result, {
      provider: current.model.provider,
      providerOwner: getModelProviderRuntimePluginHandle(current.model)?.plugin ?? null,
    });
    const mayRotate = params.canRotate?.(result, failoverReason) ?? true;
    // Rotation keeps its existing trigger; only the shared health write is narrowed.
    const rotateReason = resolveAuthProfileFailureReason({ failoverReason, providerStarted: true });
    const reason = mayRotate
      ? resolveAuthProfileFailureReason({
          failoverReason,
          providerStarted: didProviderStart(result),
        })
      : null;
    const profileId = current.auth.profileId;
    if (!profiles || !profileId || state.profileIndex < 0) {
      return result;
    }
    const health = {
      store: profiles.store,
      profileId,
      provider: current.model.provider,
      modelId: current.model.id,
      agentDir: params.agentDir,
    };
    const signal = reason ? buildAssistantFailoverSignal(result) : undefined;
    try {
      if (reason) {
        await markAuthProfileFailure({
          ...health,
          reason,
          cfg: params.cfg,
          retryAfterMs: signal?.retryAfterMs,
        });
      } else if (["stop", "length", "toolUse"].includes(result.stopReason)) {
        await markAuthProfileSuccess(health);
      }
    } catch {
      params.warn("Simple completion auth profile bookkeeping failed.");
    }
    params.assertCurrent();
    if (rotateReason && mayRotate && params.onExhausted) {
      failedProfileCount += 1;
      record(
        {
          profileId,
          reason: rotateReason,
          status: signal?.status,
          rateLimitResetAt:
            reason === "rate_limit"
              ? (getSoonestCooldownExpiry(profiles.store, [profileId], {
                  forModel: current.model.id,
                }) ?? undefined)
              : undefined,
        },
        { dispatched: true },
      );
    }
    if (!mayRotate || !rotateReason || params.signal?.aborted) {
      return result;
    }
    const advanced = await advanceAuthProfileCandidate({
      candidates: profiles.profileIds,
      state,
      isAvailable: (candidate) => {
        if (!isProfileInCooldown(profiles.store, candidate, undefined, current.model.id)) {
          return true;
        }
        record({
          profileId: candidate,
          reason: "cooldown",
          rateLimitResetAt:
            getSoonestCooldownExpiry(profiles.store, [candidate], {
              forModel: current.model.id,
            }) ?? undefined,
        });
        return false;
      },
      tryPrepare: async (candidate) => {
        params.assertCurrent();
        const next = await profiles.prepare(candidate, params.assertCurrent);
        params.assertCurrent();
        if ("error" in next) {
          record({ profileId: candidate, reason: "unavailable" });
          return false;
        }
        current = next;
        return true;
      },
    });
    if (!advanced) {
      if (failedProfileCount > 0) {
        params.onExhausted?.({
          attempts,
          failedProfileCount,
          profileCount: profiles.profileIds.length,
        });
      }
      return result;
    }
  }
}
