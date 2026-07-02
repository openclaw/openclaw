// Msteams plugin module implements durable inbound receive behavior.
import { createHash } from "node:crypto";
import {
  createDurableInboundReceiveJournalFromQueue,
  type ChannelIngressQueue,
  type DurableInboundReceiveJournal,
} from "openclaw/plugin-sdk/channel-outbound";
import type { PluginJsonValue } from "openclaw/plugin-sdk/plugin-entry";
import { DEFAULT_ACCOUNT_ID } from "../runtime-api.js";
import type { MSTeamsSdkCloudOptions } from "./cloud.js";
import { buildStoredConversationReference } from "./conversation-reference.js";
import { extractMSTeamsConversationMessageId, normalizeMSTeamsConversationId } from "./inbound.js";
import { getMSTeamsRuntime } from "./runtime.js";
import {
  deleteMSTeamsActivityWithReference,
  sendMSTeamsActivityWithReference,
  updateMSTeamsActivityWithReference,
  type MSTeamsSdkReferenceSource,
} from "./sdk-proactive.js";
import type {
  MSTeamsActivityLike,
  MSTeamsActivityParams,
  MSTeamsTurnContext,
} from "./sdk-types.js";
import type { MSTeamsApp } from "./sdk.js";

const MSTEAMS_DURABLE_INBOUND_PENDING_MAX_ENTRIES = 450;
const MSTEAMS_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES = 450;
const MSTEAMS_DURABLE_INBOUND_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MSTEAMS_DURABLE_INBOUND_COMPLETED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MSTEAMS_DURABLE_INBOUND_MAX_ATTEMPTS = 5;
export const MSTEAMS_DURABLE_INBOUND_MAX_ATTEMPTS_REASON = "max-attempts-exceeded";

export type MSTeamsDurableInboundPayload = {
  version: 1;
  kind: "card-action";
  activity: PluginJsonValue;
  receivedAt: number;
};

export type MSTeamsDurableInboundCompletedMetadata = {
  completedKind: "card-action";
};

export type MSTeamsDurableInboundJournal = DurableInboundReceiveJournal<
  MSTeamsDurableInboundPayload,
  unknown,
  MSTeamsDurableInboundCompletedMetadata
>;

type MSTeamsDurableInboundQueue = ChannelIngressQueue<
  MSTeamsDurableInboundPayload,
  unknown,
  MSTeamsDurableInboundCompletedMetadata
>;

export type MSTeamsDurableInboundReceive = {
  journal: MSTeamsDurableInboundJournal;
  fail(
    id: string,
    options: { reason: string; message?: string; failedAt?: number },
  ): Promise<boolean>;
};

function hashPart(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function serializeActivity(activity: MSTeamsTurnContext["activity"]): PluginJsonValue {
  return structuredClone(activity) as PluginJsonValue;
}

export function deserializeMSTeamsDurableActivity(
  activity: PluginJsonValue,
): MSTeamsTurnContext["activity"] {
  return structuredClone(activity) as MSTeamsTurnContext["activity"];
}

export function createMSTeamsDurableCardActionId(activity: MSTeamsTurnContext["activity"]): string {
  const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
  const activityId = typeof activity.id === "string" ? activity.id.trim() : "";
  if (activityId) {
    return hashPart(`card-action\n${conversationId}\n${activityId}`);
  }
  return hashPart(
    `card-action\n${JSON.stringify({
      conversationId,
      from: activity.from?.aadObjectId ?? activity.from?.id,
      name: activity.name,
      timestamp: activity.timestamp,
      value: activity.value,
    })}`,
  );
}

export function buildMSTeamsDurableCardActionPayload(
  activity: MSTeamsTurnContext["activity"],
): MSTeamsDurableInboundPayload {
  return {
    version: 1,
    kind: "card-action",
    activity: serializeActivity(activity),
    receivedAt: Date.now(),
  };
}

function createMSTeamsDurableInboundQueue(
  accountId = DEFAULT_ACCOUNT_ID,
): MSTeamsDurableInboundQueue {
  const runtime = getMSTeamsRuntime();
  return runtime.state.openChannelIngressQueue<
    MSTeamsDurableInboundPayload,
    unknown,
    MSTeamsDurableInboundCompletedMetadata
  >({
    accountId,
    stateDir: runtime.state.resolveStateDir(),
  });
}

export function createMSTeamsDurableInboundReceive(
  accountId = DEFAULT_ACCOUNT_ID,
): MSTeamsDurableInboundReceive {
  const queue = createMSTeamsDurableInboundQueue(accountId);
  const journal = createDurableInboundReceiveJournalFromQueue({
    queue,
    retention: {
      pendingTtlMs: MSTEAMS_DURABLE_INBOUND_PENDING_TTL_MS,
      completedTtlMs: MSTEAMS_DURABLE_INBOUND_COMPLETED_TTL_MS,
      failedTtlMs: MSTEAMS_DURABLE_INBOUND_PENDING_TTL_MS,
      pendingMaxEntries: MSTEAMS_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
      completedMaxEntries: MSTEAMS_DURABLE_INBOUND_COMPLETED_MAX_ENTRIES,
      failedMaxEntries: MSTEAMS_DURABLE_INBOUND_PENDING_MAX_ENTRIES,
    },
  });
  return {
    journal,
    fail: (id, options) => queue.fail(id, options),
  };
}

function resolveActivityReferenceParts(activity: MSTeamsTurnContext["activity"]) {
  const rawConversationId = activity.conversation?.id ?? "";
  const conversationId = normalizeMSTeamsConversationId(rawConversationId);
  const conversationMessageId = extractMSTeamsConversationMessageId(rawConversationId);
  const conversationType = activity.conversation?.conversationType ?? "personal";
  const teamId = activity.channelData?.team?.id;
  const threadId =
    conversationType === "channel" ? (conversationMessageId ?? activity.replyToId) : undefined;
  const ref = buildStoredConversationReference({
    activity,
    conversationId,
    conversationType,
    teamId,
    threadId,
  });
  const conversation = ref.conversation;
  if (!conversation?.id) {
    throw new Error("MSTeams durable inbound replay requires conversation.id");
  }
  const sdkRef: MSTeamsSdkReferenceSource = {
    ...ref,
    conversation: {
      id: conversation.id,
      conversationType: conversation.conversationType,
      tenantId: conversation.tenantId,
    },
  };
  return { ref: sdkRef, threadId };
}

export function createMSTeamsDurableTurnContext(params: {
  app: MSTeamsApp;
  activity: MSTeamsTurnContext["activity"];
  serviceUrlBoundary: MSTeamsSdkCloudOptions;
}): MSTeamsTurnContext {
  const { ref, threadId } = resolveActivityReferenceParts(params.activity);
  const proactiveOptions = {
    serviceUrlBoundary: params.serviceUrlBoundary,
    ...(threadId ? { threadActivityId: threadId } : {}),
  };
  return {
    activity: params.activity,
    sendActivity: async (activity: MSTeamsActivityLike) =>
      await sendMSTeamsActivityWithReference(params.app, ref, activity, proactiveOptions),
    sendActivities: async (activities: Array<MSTeamsActivityParams>) => {
      const results: unknown[] = [];
      for (const activity of activities) {
        results.push(
          await sendMSTeamsActivityWithReference(params.app, ref, activity, proactiveOptions),
        );
      }
      return results;
    },
    updateActivity: async (activity: MSTeamsActivityParams) => {
      const activityId = typeof activity.id === "string" ? activity.id : "";
      if (!activityId) {
        throw new Error("MSTeams durable activity update requires activity.id");
      }
      const result = await updateMSTeamsActivityWithReference(
        params.app,
        ref,
        activityId,
        activity,
        proactiveOptions,
      );
      return result && typeof result === "object" ? (result as { id?: string }) : undefined;
    },
    deleteActivity: async (activityId: string) => {
      await deleteMSTeamsActivityWithReference(params.app, ref, activityId, proactiveOptions);
    },
  };
}
