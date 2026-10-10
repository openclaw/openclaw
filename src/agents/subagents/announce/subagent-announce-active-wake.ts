import { isFastTestRuntimeEnv } from "../../../infra/env.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import { sessionDeliveryChannel } from "../../../utils/delivery-context.read.js";
import type { EmbeddedAgentQueueMessageOptions } from "../../embedded-agent-runner/run-state.js";
import {
  queueEmbeddedAgentMessageWithOutcomeAsync,
  queueGuardedEmbeddedAgentMessageWithOutcomeAsync,
  resolveEmbeddedRunAbandonment,
  type EmbeddedAgentQueueMessageOutcome,
} from "../../embedded-agent-runner/runs.js";
import type { CurrentInboundPromptContext } from "../../internal-runtime-context.js";
import { waitForAnnounceRetryDelay } from "./subagent-announce-delivery-retry.js";
import {
  getSubagentRequesterSessionActivity as resolveRequesterSessionActivity,
  loadRequesterSessionEntry,
  resolveQueueSettings,
  withSubagentRequesterSource,
} from "./subagent-announce-delivery.runtime.js";

export const SOURCE_OWNER_CHANGED = Symbol("source_owner_changed");

export { resolveRequesterSessionActivity };

// Wake an active requester run through transient compacting and delivery-mode
// outcomes. Unsupported transcript-commit waits are terminal refusals: the loop
// keeps the requested gate intact and lets the caller fall through to the
// canonical requester-agent handoff instead of re-steering on stale context.
export async function resolveActiveWakeWithRetries(
  sessionId: string,
  message: string,
  wakeOptions: EmbeddedAgentQueueMessageOptions,
  signal?: AbortSignal,
  isAttemptAllowed?: () => boolean,
  isSourceSessionAdmissionAllowed?: () => boolean,
): Promise<EmbeddedAgentQueueMessageOutcome | typeof SOURCE_OWNER_CHANGED> {
  // Bound the whole active wake by the caller's delivery window. Each retry
  // passes only the remaining window into transcript-commit waiting so a
  // near-deadline retry cannot add another full timeout.
  const compactionDeadlineMs =
    typeof wakeOptions.deliveryTimeoutMs === "number" && wakeOptions.deliveryTimeoutMs > 0
      ? Date.now() + wakeOptions.deliveryTimeoutMs
      : undefined;
  let currentOptions = wakeOptions;
  const resolveRetryOptions = (): EmbeddedAgentQueueMessageOptions | undefined => {
    if (compactionDeadlineMs === undefined) {
      return currentOptions;
    }
    const remainingDeliveryTimeoutMs = compactionDeadlineMs - Date.now();
    if (remainingDeliveryTimeoutMs <= 0) {
      return undefined;
    }
    return {
      ...currentOptions,
      deliveryTimeoutMs: remainingDeliveryTimeoutMs,
    };
  };
  const canInject = isSourceSessionAdmissionAllowed
    ? () => isAttemptAllowed?.() !== false && isSourceSessionAdmissionAllowed()
    : undefined;
  const attemptWake = async (options: EmbeddedAgentQueueMessageOptions) => {
    if (isAttemptAllowed?.() === false || isSourceSessionAdmissionAllowed?.() === false) {
      return SOURCE_OWNER_CHANGED;
    }
    const result = canInject
      ? await queueGuardedEmbeddedAgentMessageWithOutcomeAsync(
          sessionId,
          message,
          options,
          canInject,
        )
      : await queueEmbeddedAgentMessageWithOutcomeAsync(sessionId, message, options);
    return isAttemptAllowed?.() === false ? SOURCE_OWNER_CHANGED : result;
  };
  let outcome = await attemptWake(currentOptions);
  const compactionRetryDelaysMs = isFastTestRuntimeEnv()
    ? ([8, 16, 32, 64] as const)
    : ([1_000, 2_000, 4_000, 8_000] as const);
  let compactionRetryIndex = 0;
  for (;;) {
    if (outcome === SOURCE_OWNER_CHANGED || outcome.queued || signal?.aborted) {
      break;
    }
    if (isAttemptAllowed?.() === false || isSourceSessionAdmissionAllowed?.() === false) {
      outcome = SOURCE_OWNER_CHANGED;
      break;
    }
    if (
      outcome.reason === "source_reply_delivery_mode_mismatch" &&
      currentOptions.sourceReplyDeliveryMode !== undefined
    ) {
      // Active requester runs own the final delivery mode. Direct-completion
      // policy must not make an already-running automatic parent unreachable.
      const activeRunOptions = { ...currentOptions };
      delete activeRunOptions.sourceReplyDeliveryMode;
      currentOptions = activeRunOptions;
    } else if (outcome.reason === "compacting") {
      const remainingDeliveryTimeoutMs =
        compactionDeadlineMs === undefined ? undefined : compactionDeadlineMs - Date.now();
      const canRetry =
        remainingDeliveryTimeoutMs === undefined
          ? compactionRetryIndex < compactionRetryDelaysMs.length
          : remainingDeliveryTimeoutMs > 0;
      if (!canRetry) {
        break;
      }
      const scheduledDelayMs =
        compactionRetryDelaysMs[
          Math.min(compactionRetryIndex, compactionRetryDelaysMs.length - 1)
        ] ?? 0;
      const delayMs =
        remainingDeliveryTimeoutMs === undefined
          ? scheduledDelayMs
          : Math.min(scheduledDelayMs, remainingDeliveryTimeoutMs);
      if (delayMs <= 0 && remainingDeliveryTimeoutMs !== undefined) {
        break;
      }
      await waitForAnnounceRetryDelay(delayMs, signal);
      if (signal?.aborted) {
        break;
      }
      compactionRetryIndex += 1;
    } else {
      break;
    }
    const retryOptions = resolveRetryOptions();
    if (!retryOptions) {
      break;
    }
    outcome = await attemptWake(retryOptions);
  }
  return outcome;
}

export async function maybeSteerSubagentAnnounce(params: {
  deliveryTimeoutMs?: number;
  requesterSessionKey: string;
  requesterAgentId?: string;
  steerMessage: string;
  currentInboundContext?: CurrentInboundPromptContext;
  createUserTurnTranscriptRecorder?: (sessionId: string) => UserTurnTranscriptRecorder;
  signal?: AbortSignal;
  isSourceSessionEffectsAllowed?: () => boolean;
  isSourceSessionAdmissionAllowed?: () => boolean;
}): Promise<
  | { status: "steered"; deliveredAt?: number; enqueuedAt?: number }
  | { status: "none" | "dropped" | "source_owner_changed" }
> {
  return withSubagentRequesterSource(
    params.requesterSessionKey,
    params.requesterAgentId,
    async (isRequesterCurrent): Promise<Awaited<ReturnType<typeof maybeSteerSubagentAnnounce>>> => {
      const guardedParams = isRequesterCurrent
        ? {
            ...params,
            isSourceSessionEffectsAllowed: () =>
              isRequesterCurrent() && params.isSourceSessionEffectsAllowed?.() !== false,
            isSourceSessionAdmissionAllowed: () =>
              isRequesterCurrent() && params.isSourceSessionAdmissionAllowed?.() !== false,
          }
        : params;
      return maybeSteerSubagentAnnounceBound(guardedParams);
    },
  );
}

async function maybeSteerSubagentAnnounceBound(
  params: Parameters<typeof maybeSteerSubagentAnnounce>[0],
): ReturnType<typeof maybeSteerSubagentAnnounce> {
  if (params.signal?.aborted) {
    return { status: "none" };
  }
  const requester = await loadRequesterSessionEntry(
    params.requesterSessionKey,
    params.requesterAgentId,
  );
  const { cfg, entry, canonicalKey } = requester;
  const { sessionId, isActive } = resolveRequesterSessionActivity(
    params.requesterSessionKey,
    requester,
  );
  if (resolveEmbeddedRunAbandonment({ sessionKey: canonicalKey, sessionId })) {
    return { status: "none" };
  }
  if (!sessionId || !isActive) {
    return { status: "none" };
  }

  const queueSettings = resolveQueueSettings({
    cfg,
    channel: sessionDeliveryChannel(entry),
    sessionEntry: entry,
  });

  // Subagent announcements are internal handoffs into an active requester turn.
  // Queue modes such as followup/collect apply to user prompts, not this path.
  const queueOptions: EmbeddedAgentQueueMessageOptions = {
    deliveryTimeoutMs: params.deliveryTimeoutMs,
    steeringMode: "all",
    ...(queueSettings.debounceMs !== undefined ? { debounceMs: queueSettings.debounceMs } : {}),
    waitForTranscriptCommit: true,
    ...(params.currentInboundContext
      ? { currentInboundContext: params.currentInboundContext }
      : {}),
    ...(params.createUserTurnTranscriptRecorder
      ? { userTurnTranscriptRecorder: params.createUserTurnTranscriptRecorder(sessionId) }
      : {}),
  };
  const queueOutcome = await resolveActiveWakeWithRetries(
    sessionId,
    params.steerMessage,
    queueOptions,
    params.signal,
    params.isSourceSessionEffectsAllowed,
    params.isSourceSessionAdmissionAllowed,
  );
  if (queueOutcome === SOURCE_OWNER_CHANGED) {
    return { status: "source_owner_changed" };
  }
  if (queueOutcome.queued) {
    return {
      status: "steered",
      deliveredAt: queueOutcome.deliveredAtMs,
      enqueuedAt: queueOutcome.enqueuedAtMs,
    };
  }

  // A stale_run refusal means the requester run is evidence-dead: it will not
  // drain its steer queue, so "dropped" would discard the handoff. Report
  // not-active so dispatch takes the direct fallback instead.
  // Unguarded sinks likewise leave source-bound input to the direct Gateway path.
  if (
    queueOutcome.reason === "stale_run" ||
    queueOutcome.reason === "transcript_commit_wait_unsupported" ||
    (params.isSourceSessionAdmissionAllowed !== undefined &&
      queueOutcome.reason === "guarded_injection_unsupported")
  ) {
    return { status: "none" };
  }
  const currentActivity = resolveRequesterSessionActivity(
    params.requesterSessionKey,
    await loadRequesterSessionEntry(params.requesterSessionKey, params.requesterAgentId),
  );
  return { status: currentActivity.isActive ? "dropped" : "none" };
}
