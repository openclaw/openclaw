import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AssistantMessage, Model } from "../llm/types.js";
import { getModelProviderRuntimePluginHandle } from "../plugins/provider-hook-runtime.js";
import { advanceAuthProfileCandidate } from "./auth-profiles/advance.js";
import { markAuthProfileSuccess } from "./auth-profiles/profiles.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { isProfileInCooldown } from "./auth-profiles/usage-state.js";
import { markAuthProfileFailure } from "./auth-profiles/usage.js";
import { classifyAssistantFailoverReason } from "./embedded-agent-helpers/assistant-message-failures.js";
import { resolveAuthProfileFailureReason } from "./embedded-agent-runner/run/auth-profile-failure-policy.js";
import type { PreparedSimpleCompletionModel } from "./simple-completion.types.js";

type PreparedModel = Extract<PreparedSimpleCompletionModel, { model: Model }>;

export type SimpleCompletionAuthProfiles = {
  store: AuthProfileStore;
  profileIds: readonly string[];
  prepare(profileId: string, assertCurrent: () => void): Promise<PreparedSimpleCompletionModel>;
};

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
    const reason = resolveAuthProfileFailureReason({
      failoverReason: classifyAssistantFailoverReason(result, {
        provider: current.model.provider,
        providerOwner: getModelProviderRuntimePluginHandle(current.model)?.plugin ?? null,
      }),
      providerStarted: true,
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
        await markAuthProfileFailure({ ...health, reason, cfg: params.cfg });
      } else if (["stop", "length", "toolUse"].includes(result.stopReason)) {
        await markAuthProfileSuccess(health);
      }
    } catch {
      params.warn("Simple completion auth profile bookkeeping failed.");
    }
    params.assertCurrent();
    if (!reason || params.signal?.aborted) {
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
