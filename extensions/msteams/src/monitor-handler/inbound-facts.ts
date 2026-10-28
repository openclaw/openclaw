import { decodeHtmlEntities } from "openclaw/plugin-sdk/html-entity-runtime";
import { serializeMSTeamsAdaptiveCardActionValue } from "../adaptive-card-submit.js";
import {
  resolveMSTeamsAdvertisedMedia,
  summarizeMSTeamsHtmlAttachments,
} from "../attachments/html.js";
import { extractHtmlFromAttachment } from "../attachments/shared.js";
import type { MSTeamsAttachmentLike } from "../attachments/types.js";
import { tryNormalizeBotFrameworkServiceUrl } from "../bot-framework-service-url.js";
import type { StoredConversationReference } from "../conversation-store.js";
import {
  extractMSTeamsConversationMessageId,
  extractMSTeamsQuoteInfo,
  htmlToPlainText,
  normalizeMSTeamsConversationId,
  stripMSTeamsMentionTags,
  wasMSTeamsBotMentioned,
} from "../inbound.js";
import type { MSTeamsIngressLifecycle } from "../msteams-ingress.js";
import type { MSTeamsTurnContext } from "../sdk-types.js";
import { wasMSTeamsMessageSentWithPersistence } from "../sent-message-cache.js";

// Quoted messages have their own provenance in quoteInfo; do not promote their
// links into the current request. Track nesting and fail closed on an open quote.
function stripQuotedHtml(html: string): string {
  let depth = 0;
  let offset = 0;
  let result = "";
  for (const match of html.matchAll(/<\/?blockquote\b[^>]*>/gi)) {
    if (depth === 0) {
      result += html.slice(offset, match.index);
    }
    depth = match[0].startsWith("</") ? Math.max(0, depth - 1) : depth + 1;
    offset = match.index + match[0].length;
  }
  return result + (depth === 0 ? html.slice(offset) : "");
}

function extractHtmlTextAndLinks(attachments: MSTeamsAttachmentLike[]) {
  let text = "";
  const links = new Set<string>();
  for (const attachment of attachments) {
    const raw = extractHtmlFromAttachment(attachment);
    if (!raw) {
      continue;
    }
    const html = stripQuotedHtml(raw).replace(/<at\b[^>]*>.*?<\/at>/gis, " ");
    const withLinks = html.replace(
      /<a\b([^>]*)>(.*?)<\/a>/gis,
      (_anchor, attributes: string, label: string) => {
        const href = [
          ...attributes.matchAll(
            /(?:^|\s)([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g,
          ),
        ].find((attribute) => attribute[1].toLowerCase() === "href");
        const encoded = href?.[2] ?? href?.[3] ?? href?.[4];
        if (!encoded) {
          return ` ${label} `;
        }
        const url = decodeHtmlEntities(encoded).trim();
        if (
          !/^https?:\/\//i.test(url) ||
          /[\s<>"']/.test(url) ||
          [...url].some(
            (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
          )
        ) {
          return ` ${label} `;
        }
        try {
          const parsed = new URL(url);
          if (!parsed.hostname || parsed.username || parsed.password) {
            return ` ${label} `;
          }
        } catch {
          return ` ${label} `;
        }
        links.add(url);
        return htmlToPlainText(label) === url ? ` ${label} ` : ` ${label} ${encoded} `;
      },
    );
    text ||= htmlToPlainText(withLinks);
  }
  return { text, links };
}

function appendMissingLinks(text: string, links: Set<string>): string {
  const missing = [...links].filter((url) => !text.includes(url));
  return missing.length ? `${text}\n${missing.join("\n")}`.trim() : text;
}

export type MSTeamsDebounceEntry = Awaited<ReturnType<typeof prepareMSTeamsDebounceEntry>>;

export async function prepareMSTeamsDebounceEntry(params: {
  context: MSTeamsTurnContext;
  accountId: string;
  turnAdoptionLifecycle?: MSTeamsIngressLifecycle;
}) {
  const activity = params.context.activity;
  const attachments: MSTeamsAttachmentLike[] = Array.isArray(activity.attachments)
    ? activity.attachments
    : [];
  const rawText = activity.text?.trim() ?? "";
  const html = extractHtmlTextAndLinks(attachments);
  // HTML mentions are stripped before decoding so literally typed <at> tags survive.
  const text = rawText
    ? appendMissingLinks(stripMSTeamsMentionTags(rawText), html.links)
    : html.text ||
      stripMSTeamsMentionTags(serializeMSTeamsAdaptiveCardActionValue(activity.value) || "");
  const conversationId = normalizeMSTeamsConversationId(activity.conversation?.id ?? "");
  const replyToId = activity.replyToId;
  const implicitMentionKinds: Array<"reply_to_bot"> =
    conversationId &&
    replyToId &&
    (await wasMSTeamsMessageSentWithPersistence({
      conversationId,
      messageId: replyToId,
      accountId: params.accountId,
    }))
      ? ["reply_to_bot"]
      : [];

  return {
    context: params.context,
    rawText,
    text,
    attachments,
    wasMentioned: wasMSTeamsBotMentioned(activity),
    implicitMentionKinds,
    turnAdoptionLifecycle: params.turnAdoptionLifecycle,
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
  const threadId = isChannel ? (conversationMessageId ?? activity.replyToId) : undefined;
  const advertisedMedia = resolveMSTeamsAdvertisedMedia(entry.attachments);
  const from = activity.from;
  const clientInfo = activity.entities?.find((entity) => entity.type === "clientInfo") as
    | { timezone?: string }
    | undefined;
  // Proactive sends require the tenant and normalized regional service URL
  // captured from the original Bot Framework activity.
  const tenantId = activity.channelData?.tenant?.id ?? conversation?.tenantId;
  const aadObjectId = from?.aadObjectId;
  const serviceUrl = tryNormalizeBotFrameworkServiceUrl(activity.serviceUrl);
  const conversationRef: StoredConversationReference = {
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

  return {
    ...entry,
    activity,
    from: activity.from,
    conversation,
    rawBody: entry.text,
    advertisedMedia,
    quoteInfo: extractMSTeamsQuoteInfo(entry.attachments),
    htmlSummary: summarizeMSTeamsHtmlAttachments(entry.attachments),
    conversationId,
    conversationMessageId,
    conversationType,
    isChannel,
    teamId,
    graphChannelId: activity.channelData?.channel?.id?.trim() || conversationId,
    threadId,
    // Pending history must follow the channel thread through recording, reads, and cleanup.
    historyKey: threadId ? `${conversationId}:thread:${threadId}` : conversationId,
    conversationRef,
  };
}
