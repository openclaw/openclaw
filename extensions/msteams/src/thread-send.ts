import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/config-runtime";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";
import { convertMarkdownTables } from "openclaw/plugin-sdk/text-runtime";
import type { OpenClawConfig } from "../runtime-api.js";
import { buildTeamsFileInfoCard } from "./graph-chat.js";
import {
  getDriveItemProperties,
  uploadAndShareOneDrive,
  uploadAndShareSharePoint,
} from "./graph-upload.js";
import { extractMessageId } from "./media-helpers.js";
import {
  buildConversationReference,
  sendMSTeamsMessages,
  type MSTeamsConversationReference,
} from "./messenger.js";
import { buildMSTeamsPollCard, createMSTeamsPollStoreFs } from "./polls.js";
import { resolveMSTeamsSendContext } from "./send-context.js";

const MSTEAMS_MAX_MEDIA_BYTES = 100 * 1024 * 1024;

type ThreadConversationContext = Awaited<ReturnType<typeof resolveMSTeamsSendContext>> & {
  threadConversationRef: Parameters<typeof sendMSTeamsMessages>[0]["conversationRef"];
};

function buildThreadConversationReference(params: {
  conversationRef: Parameters<typeof sendMSTeamsMessages>[0]["conversationRef"];
  rootMessageId: string;
}): Parameters<typeof sendMSTeamsMessages>[0]["conversationRef"] {
  return {
    ...params.conversationRef,
    activityId: params.rootMessageId,
    conversation: {
      ...params.conversationRef.conversation,
      conversationType: "channel",
    },
  };
}

async function resolveThreadConversationContext(params: {
  cfg: OpenClawConfig;
  conversationId: string;
  rootMessageId: string;
}): Promise<ThreadConversationContext> {
  const context = await resolveMSTeamsSendContext({
    cfg: params.cfg,
    to: `conversation:${params.conversationId}`,
  });
  return {
    ...context,
    threadConversationRef: buildThreadConversationReference({
      conversationRef: context.ref,
      rootMessageId: params.rootMessageId,
    }),
  };
}

function buildThreadProactiveReference(params: {
  context: ThreadConversationContext;
  rootMessageId: string;
}): MSTeamsConversationReference {
  const baseRef = buildConversationReference(params.context.ref);
  return {
    ...baseRef,
    activityId: undefined,
    conversation: {
      ...baseRef.conversation,
      id: `${baseRef.conversation.id};messageid=${params.rootMessageId}`,
      conversationType: "channel",
    },
  };
}

async function sendThreadActivity(params: {
  cfg: OpenClawConfig;
  conversationId: string;
  rootMessageId: string;
  activity: Record<string, unknown>;
}): Promise<{ messageId: string; conversationId: string }> {
  const context = await resolveThreadConversationContext(params);
  const proactiveRef = buildThreadProactiveReference({
    context,
    rootMessageId: params.rootMessageId,
  });
  let messageId = "unknown";
  await context.adapter.continueConversation(context.appId, proactiveRef, async (turnContext) => {
    const response = await turnContext.sendActivity(params.activity);
    messageId = extractMessageId(response) ?? "unknown";
  });
  return { messageId, conversationId: context.conversationId };
}

function normalizeThreadText(cfg: OpenClawConfig, text: string): string {
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "msteams",
  });
  return convertMarkdownTables(text, tableMode);
}

export async function sendThreadMessageMSTeams(params: {
  cfg: OpenClawConfig;
  conversationId: string;
  rootMessageId: string;
  text: string;
  mediaUrl?: string;
}): Promise<{ messageId: string; conversationId: string }> {
  const context = await resolveThreadConversationContext(params);
  const rendered = [
    {
      text: normalizeThreadText(params.cfg, params.text),
      ...(params.mediaUrl ? { mediaUrl: params.mediaUrl } : {}),
    },
  ];
  const messageIds = await sendMSTeamsMessages({
    replyStyle: "thread",
    adapter: context.adapter,
    appId: context.appId,
    conversationRef: context.threadConversationRef,
    messages: rendered,
    tokenProvider: context.tokenProvider,
    sharePointSiteId: context.sharePointSiteId,
    mediaMaxBytes: context.mediaMaxBytes,
  });
  return {
    messageId: messageIds[0] ?? "unknown",
    conversationId: context.conversationId,
  };
}

export async function sendThreadAdaptiveCardMSTeams(params: {
  cfg: OpenClawConfig;
  conversationId: string;
  rootMessageId: string;
  card: Record<string, unknown>;
  text?: string;
}): Promise<{ messageId: string; conversationId: string }> {
  return await sendThreadActivity({
    cfg: params.cfg,
    conversationId: params.conversationId,
    rootMessageId: params.rootMessageId,
    activity: {
      type: "message",
      ...(params.text ? { text: normalizeThreadText(params.cfg, params.text) } : {}),
      attachments: [
        {
          contentType: "application/vnd.microsoft.card.adaptive",
          content: params.card,
        },
      ],
    },
  });
}

export async function sendThreadPollMSTeams(params: {
  cfg: OpenClawConfig;
  conversationId: string;
  rootMessageId: string;
  question: string;
  options: string[];
  maxSelections?: number;
}): Promise<{ pollId: string; messageId: string; conversationId: string }> {
  const pollCard = buildMSTeamsPollCard({
    question: params.question,
    options: params.options,
    maxSelections: params.maxSelections,
  });
  const sent = await sendThreadAdaptiveCardMSTeams({
    cfg: params.cfg,
    conversationId: params.conversationId,
    rootMessageId: params.rootMessageId,
    card: pollCard.card,
  });
  const pollStore = createMSTeamsPollStoreFs();
  await pollStore.createPoll({
    id: pollCard.pollId,
    question: params.question,
    options: params.options,
    maxSelections: pollCard.maxSelections,
    createdAt: new Date().toISOString(),
    conversationId: sent.conversationId,
    messageId: sent.messageId,
    votes: {},
  });
  return {
    pollId: pollCard.pollId,
    messageId: sent.messageId,
    conversationId: sent.conversationId,
  };
}

export async function sendThreadArtifactMSTeams(params: {
  cfg: OpenClawConfig;
  conversationId: string;
  rootMessageId: string;
  text: string;
  mediaUrl: string;
  filename?: string;
  mediaLocalRoots?: readonly string[];
}): Promise<{ messageId: string; conversationId: string }> {
  const context = await resolveThreadConversationContext(params);
  const media = await loadOutboundMediaFromUrl(params.mediaUrl, {
    maxBytes: context.mediaMaxBytes ?? MSTEAMS_MAX_MEDIA_BYTES,
    mediaLocalRoots: params.mediaLocalRoots,
  });
  const contentType = media.contentType ?? "application/octet-stream";
  const fileName = params.filename?.trim() || media.fileName || "attachment";
  const normalizedText = normalizeThreadText(params.cfg, params.text);

  if (contentType.startsWith("image/") && !context.sharePointSiteId) {
    return await sendThreadMessageMSTeams({
      cfg: params.cfg,
      conversationId: params.conversationId,
      rootMessageId: params.rootMessageId,
      text: normalizedText,
      mediaUrl: `data:${contentType};base64,${media.buffer.toString("base64")}`,
    });
  }

  if (context.sharePointSiteId) {
    const uploaded = await uploadAndShareSharePoint({
      buffer: media.buffer,
      filename: fileName,
      contentType,
      tokenProvider: context.tokenProvider,
      siteId: context.sharePointSiteId,
      chatId: context.graphChatId ?? context.conversationId,
      usePerUserSharing: false,
    });
    const driveItem = await getDriveItemProperties({
      siteId: context.sharePointSiteId,
      itemId: uploaded.itemId,
      tokenProvider: context.tokenProvider,
    });
    return await sendThreadActivity({
      cfg: params.cfg,
      conversationId: params.conversationId,
      rootMessageId: params.rootMessageId,
      activity: {
        type: "message",
        ...(normalizedText ? { text: normalizedText } : {}),
        attachments: [buildTeamsFileInfoCard(driveItem)],
      },
    });
  }

  const uploaded = await uploadAndShareOneDrive({
    buffer: media.buffer,
    filename: fileName,
    contentType,
    tokenProvider: context.tokenProvider,
  });
  const linkText = normalizedText
    ? `${normalizedText}\n\n[${uploaded.name}](${uploaded.shareUrl})`
    : `[${uploaded.name}](${uploaded.shareUrl})`;
  return await sendThreadMessageMSTeams({
    cfg: params.cfg,
    conversationId: params.conversationId,
    rootMessageId: params.rootMessageId,
    text: linkText,
  });
}
