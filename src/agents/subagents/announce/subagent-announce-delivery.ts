/**
 * Subagent completion announcement delivery.
 *
 * Routes completion payloads through gateway/channel/session paths and records delivery evidence.
 */
import { completionRequiresMessageToolDelivery } from "../../../auto-reply/reply/completion-delivery-policy.js";
import { scheduleSessionDelivery } from "../../../infra/session-delivery-queue-runtime.js";
import {
  enqueueClaimedSessionDelivery,
  releaseSessionDeliveryClaim,
} from "../../../infra/session-delivery-queue-storage.js";
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
  collectAgentInternalEventMedia,
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
} from "../../internal-events.js";
import { admitCorrelatedSubagentSessionDelivery } from "../completion/subagent-completion-delivery.js";
import { getSubagentDepthFromSessionStore } from "../spawn/subagent-depth.js";
import { maybeSteerSubagentAnnounce } from "./subagent-announce-active-wake.js";
import {
  resolveSubagentAnnounceTimeoutMs,
  runAnnounceDeliveryWithRetry,
  summarizeDeliveryError,
} from "./subagent-announce-delivery-retry.js";
import {
  getSubagentAnnounceRuntimeConfig,
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
} from "./subagent-announce-delivery.runtime.js";
import {
  sendSubagentAnnounceDirectly,
  type SubagentAnnounceDirectParams,
} from "./subagent-announce-direct-delivery.js";
import {
  runSubagentAnnounceDispatch,
  sourceOwnerChangedResult,
  type SubagentAnnounceDeliveryResult,
} from "./subagent-announce-dispatch.js";
import {
  resolveCompletionDeliveryOrigins,
  resolveGeneratedMediaSessionDeliveryRoute,
} from "./subagent-announce-origin.js";
import { resolveRequesterStoreKey } from "./subagent-requester-store-key.js";

export {
  loadRequesterSessionEntry,
  loadSessionEntryByKey,
  resolveSubagentAnnounceTimeoutMs,
  runAnnounceDeliveryWithRetry,
};

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

function createCompletionUserTurnTranscriptRecorderFactory(params: {
  directIdempotencyKey: string;
  requesterAgentId?: string;
  sourceSessionKey?: string;
  sourceTool?: string;
  targetRequesterSessionKey: string;
  triggerMessage: string;
}): (sessionId: string) => UserTurnTranscriptRecorder {
  const provenance: InputProvenance = {
    kind: "inter_session",
    ...(params.sourceSessionKey ? { sourceSessionKey: params.sourceSessionKey } : {}),
    sourceChannel: INTERNAL_PROVENANCE_SOURCE_CHANNEL,
    sourceTool: params.sourceTool ?? "subagent_announce",
  };
  const recorders = new Map<string, UserTurnTranscriptRecorder>();
  return (sessionId) => {
    const existing = recorders.get(sessionId);
    if (existing) {
      return existing;
    }
    // Retries targeting one session share a recorder. A successor session gets
    // its own target guard while the logical idempotency key remains stable.
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: params.triggerMessage,
        idempotencyKey: `${params.directIdempotencyKey}:active-wake`,
        provenance,
      },
      target: () => {
        const loaded = loadRequesterSessionEntry(
          params.targetRequesterSessionKey,
          params.requesterAgentId,
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
    recorders.set(sessionId, recorder);
    return recorder;
  };
}

export async function deliverSubagentAnnouncement(
  params: Omit<SubagentAnnounceDirectParams, "createUserTurnTranscriptRecorder"> & {
    steerMessage: string;
    sourceRunId?: string;
    requireDirectDelivery?: boolean;
  },
): Promise<SubagentAnnounceDeliveryResult> {
  const sourceOwnerChanged = () =>
    params.isSourceSessionEffectsAllowed?.() === false ||
    params.isSourceSessionAdmissionAllowed?.() === false;
  if (sourceOwnerChanged()) {
    return sourceOwnerChangedResult();
  }
  const durableGeneratedMediaHandoff =
    params.expectsCompletionMessage &&
    isAgentMediatedCompletionSourceTool(params.sourceTool) &&
    hasGeneratedMediaCompletionEvent(params.internalEvents);
  let durableQueue:
    | { id: string; claimed: boolean; context: OpenClawStateWorkerContext }
    | undefined;
  if (durableGeneratedMediaHandoff) {
    try {
      const cfg = getSubagentAnnounceRuntimeConfig();
      const canonicalSessionKey = resolveRequesterStoreKey(
        cfg,
        params.targetRequesterSessionKey,
        params.requesterAgentId,
      );
      const queuedRoute = resolveGeneratedMediaSessionDeliveryRoute({
        ...params,
        sessionKey: canonicalSessionKey,
      });
      const { requesterSessionOrigin, effectiveDirectOrigin } =
        resolveCompletionDeliveryOrigins(params);
      const requesterEntry = loadRequesterSessionEntry(
        params.targetRequesterSessionKey,
        params.requesterAgentId,
      ).entry;
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
      const expectedMedia = collectExpectedMediaFromInternalEvents(params.internalEvents);
      const queuePayload = {
        kind: "agentTurn",
        sessionKey: canonicalSessionKey,
        message: formatAgentInternalEventsForPrompt(params.internalEvents) || params.triggerMessage,
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
      } as const;
      const queueContext = captureOpenClawStateWorkerContext();
      const queued = params.sourceRunId
        ? admitCorrelatedSubagentSessionDelivery({
            runId: params.sourceRunId,
            payload: queuePayload,
          })
        : await enqueueClaimedSessionDelivery(
            queuePayload,
            resolveSubagentAnnounceTimeoutMs(cfg),
            queueContext,
          );
      if (queued.status === "failed") {
        return {
          delivered: false,
          path: "queued",
          reason: "completion_handoff_unavailable",
          error: "generated media session handoff was already dead-lettered",
          disposition: "permanent_failure",
        };
      }
      if (queued.status === "completed") {
        return { delivered: true, path: "queued", disposition: "delivered" };
      }
      durableQueue = { id: queued.id, claimed: queued.claimed, context: queueContext };
    } catch (error) {
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

  const createCompletionUserTurnTranscriptRecorder = params.expectsCompletionMessage
    ? createCompletionUserTurnTranscriptRecorderFactory(params)
    : undefined;

  const delivery = await runSubagentAnnounceDispatch({
    expectsCompletionMessage: params.expectsCompletionMessage,
    requireDirectDelivery: params.requireDirectDelivery || params.completionTarget === "parent",
    signal: params.signal,
    steer: async () => {
      if (sourceOwnerChanged()) {
        return { status: "source_owner_changed" };
      }
      return await maybeSteerSubagentAnnounce({
        deliveryTimeoutMs: resolveSubagentAnnounceTimeoutMs(getSubagentAnnounceRuntimeConfig()),
        requesterSessionKey: params.requesterSessionKey,
        requesterAgentId: params.requesterAgentId,
        steerMessage: params.steerMessage,
        createUserTurnTranscriptRecorder: createCompletionUserTurnTranscriptRecorder,
        signal: params.signal,
        isSourceSessionEffectsAllowed: params.isSourceSessionEffectsAllowed,
        isSourceSessionAdmissionAllowed: params.isSourceSessionAdmissionAllowed,
      });
    },
    direct: async () => {
      if (sourceOwnerChanged()) {
        return sourceOwnerChangedResult();
      }
      return await sendSubagentAnnounceDirectly({
        ...params,
        createUserTurnTranscriptRecorder: createCompletionUserTurnTranscriptRecorder,
      });
    },
  });
  const failedDirect =
    params.expectsCompletionMessage || params.sourceTool === "subagent_announce"
      ? delivery.phases?.find(
          (phase) =>
            phase.phase === "direct-primary" && !phase.delivered && phase.path === "direct",
        )
      : undefined;
  if (failedDirect?.error) {
    const source = params.sourceRunId
      ? `run ${params.sourceRunId}`
      : `session ${params.sourceSessionKey ?? params.requesterSessionKey}`;
    defaultRuntime.log(
      `[warn] Subagent completion direct announce failed for ${source}: ${failedDirect.error}${delivery.delivered ? "; recovered via steered" : ""}`,
    );
  }
  return delivery;
}
