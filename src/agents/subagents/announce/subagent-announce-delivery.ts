import { completionRequiresMessageToolDelivery } from "../../../auto-reply/reply/completion-delivery-policy.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import {
  enqueueClaimedSessionDelivery,
  releaseSessionDeliveryClaim,
} from "../../../infra/session-delivery-queue-storage.js";
import {
  SessionDeliveryDeadLetteredError,
  type SessionDeliveryRequesterBinding,
} from "../../../infra/session-delivery-queue.records.js";
import { createSubsystemLogger } from "../../../logging/subsystem.js";
import { defaultRuntime } from "../../../runtime.js";
import {
  INTERNAL_PROVENANCE_SOURCE_CHANNEL,
  isAgentMediatedCompletionSourceTool,
  type InputProvenance,
} from "../../../sessions/input-provenance.js";
import { isCronSessionKey } from "../../../sessions/session-key-utils.js";
import { createUserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.js";
import type { UserTurnTranscriptRecorder } from "../../../sessions/user-turn-transcript.types.js";
import { captureOpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.js";
import type { OpenClawStateWorkerContext } from "../../../state/openclaw-state-worker-context.types.js";
import { INTERNAL_MESSAGE_CHANNEL } from "../../../utils/message-channel.js";
import { hasGeneratedMediaCompletionEvent } from "../../internal-event-contract.js";
import {
  buildAgentInternalEventContext,
  collectAgentInternalEventMedia,
  type AgentInternalEvent,
} from "../../internal-events.js";
import { RUNTIME_EVENT_USER_PROMPT } from "../../internal-runtime-context.js";
import { admitCorrelatedSubagentSessionDelivery } from "../completion/subagent-completion-delivery.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import {
  resolveSubagentAnnounceTimeoutMs,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  getSubagentAnnounceRuntimeConfig,
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
  withSubagentRequesterDelivery,
} from "./subagent-announce-delivery.runtime.js";
import { sendSubagentAnnounceDirectly } from "./subagent-announce-direct-delivery.js";
import {
  sourceOwnerChangedResult,
  type SubagentAnnounceDeliveryResult,
  type SubagentAnnounceDirectParams,
} from "./subagent-announce-dispatch.js";
import {
  resolveCompletionDeliveryOrigins,
  resolveGeneratedMediaSessionDeliveryRoute,
} from "./subagent-announce-origin.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

const log = createSubsystemLogger("agents/subagent-announce");

export { loadRequesterSessionEntry, loadSessionEntryByKey, resolveSubagentAnnounceTimeoutMs };

export function isInternalAnnounceRequesterSession(sessionKey: string | undefined): boolean {
  return getSubagentDepthFromSessionStore(sessionKey) >= 1 || isCronSessionKey(sessionKey);
}

function collectExpectedMediaFromInternalEvents(events: AgentInternalEvent[] | undefined): {
  expectedMediaUrls: string[];
  expectedMediaAttachments?: Record<string, NonNullable<AgentInternalEvent["attachments"]>[number]>;
} {
  const { mediaUrls: expectedMediaUrls, attachments } = collectAgentInternalEventMedia(events);
  const expectedMediaAttachments = Object.fromEntries(
    expectedMediaUrls.map((mediaUrl, index) => [mediaUrl, attachments[index] ?? {}]),
  );
  return {
    expectedMediaUrls,
    ...(expectedMediaUrls.length > 0 ? { expectedMediaAttachments } : {}),
  };
}

export async function deliverSubagentAnnouncement(
  params: Omit<SubagentAnnounceDirectParams, "createUserTurnTranscriptRecorder"> & {
    sourceRunId?: string;
    preparedRequester?: { binding: SessionDeliveryRequesterBinding; entry: SessionEntry };
  },
): Promise<SubagentAnnounceDeliveryResult> {
  return withSubagentRequesterDelivery(
    params.targetRequesterSessionKey,
    params,
    deliverSubagentAnnouncementBound,
  );
}

async function deliverSubagentAnnouncementBound(
  params: Parameters<typeof deliverSubagentAnnouncement>[0],
): ReturnType<typeof deliverSubagentAnnouncement> {
  const sourceOwnerChanged = () =>
    params.isSourceSessionEffectsAllowed?.() === false ||
    params.isSourceSessionAdmissionAllowed?.() === false;
  if (sourceOwnerChanged()) {
    return sourceOwnerChangedResult();
  }
  const expectedMedia = collectExpectedMediaFromInternalEvents(params.internalEvents);
  const durableGeneratedMediaHandoff =
    expectedMedia.expectedMediaUrls.length > 0 &&
    params.expectsCompletionMessage &&
    isAgentMediatedCompletionSourceTool(params.sourceTool) &&
    hasGeneratedMediaCompletionEvent(params.internalEvents);
  let durableQueue:
    | { id: string; claimed: boolean; context: OpenClawStateWorkerContext }
    | undefined;
  if (durableGeneratedMediaHandoff) {
    try {
      const cfg = getSubagentAnnounceRuntimeConfig();
      const canonicalSessionKey =
        params.preparedRequester?.binding.sessionKey ??
        resolveRequesterStoreKey(cfg, params.targetRequesterSessionKey, params.requesterAgentId);
      const queuedRoute = resolveGeneratedMediaSessionDeliveryRoute({
        ...params,
        sessionKey: canonicalSessionKey,
      });
      const { requesterSessionOrigin, effectiveDirectOrigin } =
        resolveCompletionDeliveryOrigins(params);
      const requesterEntry =
        params.preparedRequester?.entry ??
        (await loadRequesterSessionEntry(params.targetRequesterSessionKey, params.requesterAgentId))
          .entry;
      // No external route exists for an internal-only handoff. Let the normal
      // agent final enter the owning transcript instead of requiring a message tool target.
      const sourceReplyDeliveryMode =
        queuedRoute.route.channel === INTERNAL_MESSAGE_CHANNEL
          ? "automatic"
          : completionRequiresMessageToolDelivery({
                cfg,
                requesterSessionKey: params.requesterSessionKey,
                targetRequesterSessionKey: canonicalSessionKey,
                requesterEntry,
                directOrigin: effectiveDirectOrigin,
                requesterSessionOrigin,
              })
            ? "message_tool_only"
            : "automatic";
      const queuePayload = {
        kind: "agentTurn",
        sessionKey: canonicalSessionKey,
        messageId: `${params.directIdempotencyKey}:agent-loop`,
        route: queuedRoute.route,
        ...(queuedRoute.deliveryContext ? { deliveryContext: queuedRoute.deliveryContext } : {}),
        inputProvenance: {
          kind: "inter_session",
          ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
          sourceChannel: INTERNAL_PROVENANCE_SOURCE_CHANNEL,
          sourceTool: params.sourceTool ?? "subagent_announce",
        },
        sourceReplyDeliveryMode,
        ...expectedMedia,
        idempotencyKey: `${params.directIdempotencyKey}:agent-loop`,
        ...(params.preparedRequester ? { requesterBinding: params.preparedRequester.binding } : {}),
      } as const;
      const queueContext = captureOpenClawStateWorkerContext();
      const enqueueContext = {
        ...queueContext,
        admission: {
          ...queueContext.admission,
          assertCurrent: () => {
            queueContext.admission.assertCurrent();
            if (sourceOwnerChanged()) {
              throw new SessionDeliveryDeadLetteredError("media completion source owner changed");
            }
          },
        },
      };
      const queued = params.sourceRunId
        ? await admitCorrelatedSubagentSessionDelivery({
            runId: params.sourceRunId,
            payload: queuePayload,
            queueContext: enqueueContext,
          })
        : await enqueueClaimedSessionDelivery(
            queuePayload,
            resolveSubagentAnnounceTimeoutMs(cfg),
            enqueueContext,
          );
      if (queued.status === "failed") {
        throw new SessionDeliveryDeadLetteredError(
          "generated media session handoff was already dead-lettered",
        );
      }
      // The queue owns produced files only. After its receipt, this live caller
      // admits the ordinary completion input; startup delivery never starts inference.
      if (queued.status !== "completed") {
        durableQueue = { id: queued.id, claimed: queued.claimed, context: queueContext };
      }
    } catch (error) {
      if (error instanceof SessionDeliveryDeadLetteredError) {
        return {
          delivered: false,
          path: "queued",
          reason: "completion_handoff_unavailable",
          error: error.message,
          disposition: "permanent_failure",
        };
      }
      defaultRuntime.log(
        `[warn] Generated media session handoff could not be persisted; refusing ambiguous fallback: ${summarizeDeliveryError(error)}`,
      );
      return {
        delivered: false,
        path: "queued",
        reason: "completion_handoff_unavailable",
        error: "generated media session handoff could not be persisted",
        disposition: "retryable",
      };
    }
  }

  if (durableQueue) {
    if (durableQueue.claimed) {
      await releaseSessionDeliveryClaim(durableQueue.id, durableQueue.context).catch(
        (error: unknown) => {
          defaultRuntime.log(
            `[warn] Generated media session handoff lease release failed; durable recovery remains pending: ${summarizeDeliveryError(error)}`,
          );
        },
      );
    }
    await scheduleSessionDelivery(durableQueue.id, durableQueue.context).catch((error: unknown) => {
      defaultRuntime.log(
        `[warn] Generated media session handoff retry scheduling failed; durable recovery remains pending: ${summarizeDeliveryError(error)}`,
      );
    });
    return { delivered: false, path: "queued", disposition: "session_queued" };
  }

  const runtimeContextFragments = buildAgentInternalEventContext(params.internalEvents);
  let createCompletionUserTurnTranscriptRecorder:
    | ((sessionId: string) => UserTurnTranscriptRecorder)
    | undefined;
  if (params.expectsCompletionMessage) {
    const directIdempotencyKey = params.directIdempotencyKey;
    const requesterAgentId = params.requesterAgentId;
    const sourceSessionKey = params.sourceSessionKey;
    const sourceTool = params.sourceTool;
    const targetRequesterSessionKey = params.targetRequesterSessionKey;
    const transcriptMessage = runtimeContextFragments.length
      ? RUNTIME_EVENT_USER_PROMPT
      : params.triggerMessage;
    const provenance: InputProvenance = {
      kind: "inter_session",
      ...(sourceSessionKey ? { sourceSessionKey } : {}),
      sourceChannel: INTERNAL_PROVENANCE_SOURCE_CHANNEL,
      sourceTool: sourceTool ?? "subagent_announce",
    };
    // The recorder guards the exact requester session the completion steers into.
    createCompletionUserTurnTranscriptRecorder = (sessionId) =>
      createUserTurnTranscriptRecorder({
        input: {
          text: transcriptMessage,
          idempotencyKey: `${directIdempotencyKey}:active-wake`,
          provenance,
        },
        target: async () => {
          const loaded = await loadRequesterSessionEntry(
            targetRequesterSessionKey,
            requesterAgentId,
          );
          if (!loaded.entry || loaded.entry.sessionId?.trim() !== sessionId || !loaded.agentId) {
            return undefined;
          }
          return {
            sessionId,
            expectedSessionId: sessionId,
            sessionKey: loaded.canonicalKey,
            sessionEntry: loaded.entry,
            ...(loaded.storePath ? { storePath: loaded.storePath } : {}),
            agentId: loaded.agentId,
            config: loaded.cfg,
          };
        },
        errorContext: "active requester completion transcript",
      });
  }
  if (sourceOwnerChanged()) {
    return sourceOwnerChangedResult();
  }
  if (params.signal?.aborted) {
    return { delivered: false, path: "none", phases: [] };
  }
  let directError: unknown;
  const delivery = await sendSubagentAnnounceDirectly({
    ...params,
    createUserTurnTranscriptRecorder: createCompletionUserTurnTranscriptRecorder,
    onDeliveryError: (error) => {
      directError = error;
      params.onDeliveryError?.(error);
    },
  });
  const failedDirect =
    (params.expectsCompletionMessage ||
      params.sourceTool === "subagent_announce" ||
      params.sourceTool === "subagent_settle") &&
    !delivery.delivered &&
    delivery.path === "direct"
      ? delivery
      : undefined;
  if (failedDirect?.error) {
    const source = params.sourceRunId
      ? `run ${params.sourceRunId}`
      : `session ${params.sourceSessionKey ?? params.requesterSessionKey}`;
    log.warn(`Subagent completion direct announce failed for ${source}`, {
      err: directError ?? failedDirect.error,
      runId: params.sourceRunId,
      requesterSessionKey: params.targetRequesterSessionKey,
      sourceTool: params.sourceTool,
      directIdempotencyKey: params.directIdempotencyKey,
    });
  }
  return {
    ...delivery,
    // Phase names describe the dispatch stage, even when direct delivery steers internally.
    phases: [
      {
        phase: "direct-primary",
        delivered: delivery.delivered,
        path: delivery.path,
        deliveredAt: delivery.deliveredAt,
        enqueuedAt: delivery.enqueuedAt,
        ...(delivery.reason ? { reason: delivery.reason } : {}),
        error: delivery.error,
      },
    ],
  };
}
