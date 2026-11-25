import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AssistantMessage, Model } from "../llm/types.js";
import { getModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { advanceAuthProfileCandidate } from "./auth-profiles/advance.js";
import { markAuthProfileSuccess } from "./auth-profiles/profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isProfileInCooldown } from "./auth-profiles/usage-state.js";
import { markAuthProfileFailure } from "./auth-profiles/usage.js";
import {
  buildAssistantFailoverSignal,
  classifyAssistantFailoverReason,
} from "./embedded-agent-helpers/assistant-message-failures.js";
import { resolveAuthProfileFailureReason } from "./embedded-agent-runner/run/auth-profile-failure-policy.js";
import type { PreparedSimpleCompletionModel } from "./simple-completion.types.js";

type PreparedModel = Extract<PreparedSimpleCompletionModel, { model: Model }>;

export type SimpleCompletionAuthProfiles = {
  store: AuthProfileStore;
  profileIds: readonly string[];
  prepare(profileId: string, assertCurrent: () => void): Promise<PreparedSimpleCompletionModel>;
};

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
  warn(message: string): void;
}): Promise<AssistantMessage> {
  const profiles = params.prepared.authProfiles;
  let current: PreparedModel = params.prepared;
  const state = { profileIndex: profiles?.profileIds.indexOf(current.auth.profileId ?? "") ?? -1 };
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
    // Rotation keeps its existing trigger; only the shared health write is narrowed.
    const rotateReason = resolveAuthProfileFailureReason({ failoverReason, providerStarted: true });
    const reason = resolveAuthProfileFailureReason({
      failoverReason,
      providerStarted: didProviderStart(result),
    });
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
    try {
      if (reason) {
        await markAuthProfileFailure({
          ...health,
          reason,
          cfg: params.cfg,
          retryAfterMs: buildAssistantFailoverSignal(result).retryAfterMs,
        });
      } else if (["stop", "length", "toolUse"].includes(result.stopReason)) {
        await markAuthProfileSuccess(health);
      }
    } catch {
      params.warn("Simple completion auth profile bookkeeping failed.");
    }
    params.assertCurrent();
    if (!rotateReason || params.signal?.aborted) {
      return result;
    }
    const advanced = await advanceAuthProfileCandidate({
      candidates: profiles.profileIds,
      state,
      isAvailable: (candidate) =>
        !isProfileInCooldown(profiles.store, candidate, undefined, current.model.id),
      tryPrepare: async (candidate) => {
        params.assertCurrent();
        const next = await profiles.prepare(candidate, params.assertCurrent);
        params.assertCurrent();
        if ("error" in next) {
          return false;
        }
        current = next;
        return true;
      },
    });
    if (!advanced) {
      return result;
    }
  }
}
