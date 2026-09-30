import { serializeMSTeamsAdaptiveCardActionValue } from "../adaptive-card-submit.js";
import {
  resolveMSTeamsAdvertisedMedia,
  summarizeMSTeamsHtmlAttachments,
  type MSTeamsAttachmentLike,
} from "../attachments.js";
import { extractHtmlFromAttachment } from "../attachments/shared.js";
import { tryNormalizeBotFrameworkServiceUrl } from "../bot-framework-service-url.js";
import type { StoredConversationReference } from "../conversation-store.js";
import {
  buildMSTeamsNormalizedText,
  extractMSTeamsConversationMessageId,
  extractMSTeamsQuoteInfo,
  htmlToPlainText,
  normalizeMSTeamsConversationId,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
  type MSTeamsEntityLike,
  type MSTeamsQuoteInfo,
} from "../inbound.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { wasMSTeamsMessageSentWithPersistence } from "../sent-message-cache.js";

function extractTextFromHtmlAttachments(attachments: MSTeamsAttachmentLike[]): string {
  for (const attachment of attachments) {
    const raw = extractHtmlFromAttachment(attachment);
    if (!raw) {
      continue;
    }
    const text = htmlToPlainText(
      raw
        .replace(/<at[^>]*>.*?<\/at>/gis, " ")
        .replace(/<a\b[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/gis, "$2 $1"),
    );
    if (text) {
      return text;
    }
  }
  return "";
}

export type MSTeamsDebounceEntry = {
  context: MSTeamsTurnContext;
  rawText: string;
  text: string;
  attachments: MSTeamsAttachmentLike[];
  wasMentioned: boolean;
  implicitMentionKinds: Array<"reply_to_bot">;
  quoteInfo?: MSTeamsQuoteInfo;
  turnAdoptionLifecycle?: MSTeamsIngressLifecycle;
};

export function mergeMSTeamsQuoteInfo(
  entries: readonly Pick<MSTeamsDebounceEntry, "quoteInfo">[],
): MSTeamsQuoteInfo | undefined {
  const quoteInfos = entries.flatMap((entry) => (entry.quoteInfo ? [entry.quoteInfo] : []));
  const first = quoteInfos[0];
  if (!first) {
    return undefined;
  }
  return quoteInfos.every(
    (candidate) =>
      candidate.id === first.id &&
      candidate.senderId === first.senderId &&
      candidate.sender === first.sender &&
      candidate.body === first.body &&
      candidate.fromQuotedReplyEntity === first.fromQuotedReplyEntity,
  )
    ? first
    : undefined;
}

export async function prepareMSTeamsDebounceEntry(params: {
  context: MSTeamsTurnContext;
  turnAdoptionLifecycle?: MSTeamsIngressLifecycle;
}): Promise<MSTeamsDebounceEntry> {
  const activity = params.context.activity;
  const attachments: MSTeamsAttachmentLike[] = Array.isArray(activity.attachments)
    ? activity.attachments
    : [];
  const rawText = activity.text?.trim() ?? "";
  // HTML mentions are stripped before decoding so literally typed <at> tags survive.
  // SAFETY: SDK entities are generic records; inbound parsers validate nested values before use.
  const entities = (activity.entities ?? []) as MSTeamsEntityLike[];
  const text = rawText
    ? buildMSTeamsNormalizedText({
        text: rawText,
        entities,
        attachments,
        botId: activity.recipient?.id,
        botName: activity.recipient?.name,
      })
    : extractTextFromHtmlAttachments(attachments) ||
      stripMSTeamsMentionTags(serializeMSTeamsAdaptiveCardActionValue(activity.value) || "");
  const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
  const replyToId = activity.replyToId ?? undefined;
  const implicitMentionKinds: Array<"reply_to_bot"> =
    conversationId &&
    replyToId &&
    (await wasMSTeamsMessageSentWithPersistence({ conversationId, messageId: replyToId }))
      ? ["reply_to_bot"]
      : [];

  return {
    context: params.context,
    rawText,
    text,
    attachments,
    wasMentioned: wasMSTeamsBotMentioned(activity),
    implicitMentionKinds,
    quoteInfo: extractMSTeamsQuoteInfo(attachments, entities),
    turnAdoptionLifecycle: params.turnAdoptionLifecycle,
  };
}

function buildStoredConversationReference(params: {
  activity: MSTeamsTurnContext["activity"];
  conversationId: string;
  conversationType: string;
  teamId?: string;
  threadId?: string;
}): StoredConversationReference {
  const { activity, conversationId, conversationType, teamId, threadId } = params;
  const from = activity.from;
  const conversation = activity.conversation;
  const clientInfo = activity.entities?.find((entity) => entity.type === "clientInfo") as
    | { timezone?: string }
    | undefined;
  // Proactive sends require the tenant and normalized regional service URL
  // captured from the original Bot Framework activity.
  const tenantId = activity.channelData?.tenant?.id ?? conversation?.tenantId;
  const aadObjectId = from?.aadObjectId;
  const serviceUrl = tryNormalizeBotFrameworkServiceUrl(activity.serviceUrl);
  return {
    activityId: activity.id,
    user: from ? { id: from.id, name: from.name, aadObjectId: from.aadObjectId } : undefined,
    agent: activity.recipient,
    conversation: {
      id: conversationId,
      conversationType,
      tenantId,
    },
    ...(tenantId ? { tenantId } : {}),
    ...(aadObjectId ? { aadObjectId } : {}),
    teamId,
    channelId: activity.channelId,
    ...(serviceUrl ? { serviceUrl } : {}),
    locale: activity.locale,
    ...(clientInfo?.timezone ? { timezone: clientInfo.timezone } : {}),
    ...(threadId ? { threadId } : {}),
  };
}

export function assembleMSTeamsInboundFacts(entry: MSTeamsDebounceEntry) {
  const activity = entry.context.activity;
  const conversation = activity.conversation;
  const rawConversationId = conversation?.id ?? "";
  const conversationId = normalizeMSTeamsConversationId(rawConversationId);
  const conversationMessageId = extractMSTeamsConversationMessageId(rawConversationId);
  const conversationType = conversation?.conversationType ?? "personal";
  const isChannel = conversationType === "channel";
  const teamId = activity.channelData?.team?.id;
  const threadId = isChannel
    ? (conversationMessageId ?? activity.replyToId ?? undefined)
    : undefined;
  const advertisedMedia = resolveMSTeamsAdvertisedMedia(entry.attachments);

  return {
    ...entry,
    activity,
    from: activity.from,
    conversation,
    rawBody: entry.text,
    advertisedMedia,
    quoteInfo: entry.quoteInfo,
    attachmentTypes: entry.attachments
      .map((attachment) =>
        typeof attachment.contentType === "string" ? attachment.contentType : undefined,
      )
      .filter(Boolean)
      .slice(0, 3),
    htmlSummary: summarizeMSTeamsHtmlAttachments(entry.attachments),
    rawConversationId,
    conversationId,
    conversationMessageId,
    conversationType,
    isChannel,
    teamId,
    graphChannelId: activity.channelData?.channel?.id?.trim() || conversationId,
    threadId,
    // Pending history must follow the channel thread through recording, reads, and cleanup.
    historyKey: threadId ? `${conversationId}:thread:${threadId}` : conversationId,
    conversationRef: buildStoredConversationReference({
      activity,
      conversationId,
      conversationType,
      teamId,
      threadId,
    }),
  };
}
