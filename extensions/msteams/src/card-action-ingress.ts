// Msteams plugin owns durable admission and replay for non-poll card actions.
import { createHash } from "node:crypto";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { DEFAULT_ACCOUNT_ID } from "../runtime-api.js";
import type { MSTeamsSdkCloudOptions } from "./cloud.js";
import { buildStoredConversationReference } from "./conversation-reference.js";
import { formatUnknownError } from "./errors.js";
import {
  extractMSTeamsConversationMessageId,
  normalizeMSTeamsConversationId,
} from "./inbound.js";
import { getMSTeamsRuntime } from "./runtime.js";
import {
  deleteMSTeamsActivityWithReference,
  sendMSTeamsActivityWithReference,
  updateMSTeamsActivityWithReference,
} from "./sdk-proactive.js";
import type { MSTeamsApp } from "./sdk.js";
import type { MSTeamsActivity, MSTeamsTurnContext } from "./sdk-types.js";

const CARD_ACTION_INGRESS_VERSION = 1;
const CARD_ACTION_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const CARD_ACTION_COMPLETED_MAX_ENTRIES = 10_000;
const CARD_ACTION_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CARD_ACTION_FAILED_MAX_ENTRIES = 1_000;

type MSTeamsCardActionIngressPayload = {
  version: typeof CARD_ACTION_INGRESS_VERSION;
  receivedAt: number;
  activity: MSTeamsActivity;
};

type MSTeamsCardActionTurnAdoptionLifecycle = ReturnType<
  typeof bindIngressLifecycleToReplyOptions
>["turnAdoptionLifecycle"];

class MSTeamsCardActionIngressPermanentError extends Error {}

function cloneActivity(activity: MSTeamsActivity): MSTeamsActivity {
  return structuredClone(activity);
}

function resolveMSTeamsCardActionEventId(activity: MSTeamsActivity): string {
  const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
  const stableIdentity = activity.id?.trim()
    ? [conversationId, activity.id.trim()]
    : [
        conversationId,
        activity.from?.aadObjectId ?? activity.from?.id ?? "",
        activity.timestamp ?? activity.localTimestamp ?? "",
        activity.name ?? "",
        activity.value ?? null,
      ];
  return createHash("sha256").update(JSON.stringify(stableIdentity)).digest("hex");
}

function resolveMSTeamsCardActionLaneKey(activity: MSTeamsActivity, eventId: string): string {
  const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
  return conversationId ? `conversation:${conversationId}` : `event:${eventId}`;
}

function parsePayload(payload: MSTeamsCardActionIngressPayload): MSTeamsActivity {
  if (
    payload.version !== CARD_ACTION_INGRESS_VERSION ||
    !payload.activity ||
    typeof payload.activity !== "object" ||
    payload.activity.type !== "invoke" ||
    payload.activity.name !== "adaptiveCard/action"
  ) {
    throw new MSTeamsCardActionIngressPermanentError(
      "Microsoft Teams card-action ingress payload is invalid.",
    );
  }
  return payload.activity;
}

function createReplayContext(params: {
  app: MSTeamsApp;
  activity: MSTeamsActivity;
  serviceUrlBoundary?: MSTeamsSdkCloudOptions;
}): MSTeamsTurnContext {
  const { app, activity, serviceUrlBoundary } = params;
  const rawConversationId = activity.conversation?.id ?? "";
  const conversationId = normalizeMSTeamsConversationId(rawConversationId);
  const conversationType = activity.conversation?.conversationType ?? "personal";
  const threadId =
    conversationType === "channel"
      ? (extractMSTeamsConversationMessageId(rawConversationId) ?? activity.replyToId)
      : undefined;
  const reference = buildStoredConversationReference({
    activity,
    conversationId,
    conversationType,
    teamId: activity.channelData?.team?.id,
    threadId,
  });
  const proactiveOptions = {
    ...(threadId ? { threadActivityId: threadId } : {}),
    ...(serviceUrlBoundary ? { serviceUrlBoundary } : {}),
  };
  const sendActivity = (outbound: unknown) =>
    sendMSTeamsActivityWithReference(app, reference, outbound, proactiveOptions);
  return {
    activity,
    sendActivity,
    sendActivities: async (activities) => {
      const results: unknown[] = [];
      for (const outbound of activities) {
        results.push(await sendActivity(outbound));
      }
      return results;
    },
    updateActivity: async (outbound) => {
      const activityId = typeof outbound.id === "string" ? outbound.id : "";
      return (await updateMSTeamsActivityWithReference(
        app,
        reference,
        activityId,
        outbound,
        proactiveOptions,
      )) as { id?: string } | void;
    },
    deleteActivity: async (activityId) => {
      await deleteMSTeamsActivityWithReference(
        app,
        reference,
        activityId,
        proactiveOptions,
      );
    },
    getTeamDetails: (teamId) => app.api.teams.getById(teamId),
  };
}

export function createMSTeamsCardActionIngress(params: {
  app: MSTeamsApp;
  dispatch: (
    context: MSTeamsTurnContext,
    turnAdoptionLifecycle: MSTeamsCardActionTurnAdoptionLifecycle,
  ) => Promise<void>;
  queue?: ChannelIngressQueue<MSTeamsCardActionIngressPayload>;
  abortSignal?: AbortSignal;
  serviceUrlBoundary?: MSTeamsSdkCloudOptions;
  onLog?: (message: string) => void;
  now?: () => number;
  retryPolicy?: { maxAttempts?: number; deadLetterMinAgeMs?: number; baseMs?: number; maxMs?: number };
}) {
  const queue =
    params.queue ??
    getMSTeamsRuntime().state.openChannelIngressQueue<MSTeamsCardActionIngressPayload>({
      accountId: DEFAULT_ACCOUNT_ID,
    });
  const drain = createChannelIngressDrain<MSTeamsCardActionIngressPayload>({
    queue,
    ...(params.abortSignal ? { abortSignal: params.abortSignal } : {}),
    ...(params.onLog ? { onLog: params.onLog } : {}),
    ...(params.now ? { now: params.now } : {}),
    ...(params.retryPolicy ? { retryPolicy: params.retryPolicy } : {}),
    resolveNonRetryableFailure: (error) =>
      error instanceof MSTeamsCardActionIngressPermanentError
        ? { reason: "invalid-payload", message: error.message }
        : null,
    dispatchClaimedEvent: async (event, lifecycle) => {
      const activity = parsePayload(event.payload);
      await params.dispatch(
        createReplayContext({
          app: params.app,
          activity,
          serviceUrlBoundary: params.serviceUrlBoundary,
        }),
        bindIngressLifecycleToReplyOptions(lifecycle).turnAdoptionLifecycle,
      );
    },
    formatError: formatUnknownError,
  });

  return {
    enqueue: async (activity: MSTeamsActivity) => {
      const receivedAt = params.now?.() ?? Date.now();
      const storedActivity = cloneActivity(activity);
      const eventId = resolveMSTeamsCardActionEventId(storedActivity);
      await queue.prune({
        completedTtlMs: CARD_ACTION_COMPLETED_TTL_MS,
        completedMaxEntries: CARD_ACTION_COMPLETED_MAX_ENTRIES,
        failedTtlMs: CARD_ACTION_FAILED_TTL_MS,
        failedMaxEntries: CARD_ACTION_FAILED_MAX_ENTRIES,
        ...(params.now ? { now: receivedAt } : {}),
      });
      const result = await queue.enqueue(
        eventId,
        {
          version: CARD_ACTION_INGRESS_VERSION,
          receivedAt,
          activity: storedActivity,
        },
        {
          receivedAt,
          laneKey: resolveMSTeamsCardActionLaneKey(storedActivity, eventId),
        },
      );
      return { kind: result.kind, duplicate: result.duplicate };
    },
    drainOnce: drain.drainOnce,
    waitForIdle: drain.waitForIdle,
    dispose: drain.dispose,
  };
}
