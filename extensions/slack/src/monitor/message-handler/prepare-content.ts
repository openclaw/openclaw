import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { SlackFile, SlackMessageEvent } from "../../types.js";
import {
  MAX_SLACK_MEDIA_FILES,
  resolveSlackAttachmentContent,
  resolveSlackMedia,
  type SlackMediaResult,
  type SlackThreadStarter,
} from "../media.js";

export type SlackResolvedMessageContent = {
  rawBody: string;
  effectiveDirectMedia: SlackMediaResult[] | null;
};

const SLACK_USER_MENTION_TOKEN_RE = /<@([A-Z0-9]+)(?:\|([^>]+))?>/g;

async function normalizeSlackInboundMentions(
  text: string,
  params?: {
    botUserId?: string;
    resolveUserName?: (userId: string) => Promise<{ name?: string }>;
  },
): Promise<string> {
  if (!text.includes("<@")) {
    return text;
  }

  const matches = [...text.matchAll(SLACK_USER_MENTION_TOKEN_RE)];
  if (matches.length === 0) {
    return text;
  }

  const botUserId = normalizeOptionalString(params?.botUserId);
  const resolveUserName = params?.resolveUserName;
  const resolvedNames = new Map<string, string | null>();
  if (resolveUserName) {
    const uniqueIds = [
      ...new Set(
        matches
          .map((match) => match[1] ?? "")
          .filter((userId) => Boolean(userId) && normalizeOptionalString(userId) !== botUserId),
      ),
    ];
    await Promise.all(
      uniqueIds.map(async (userId) => {
        try {
          const resolved = normalizeOptionalString((await resolveUserName(userId))?.name);
          resolvedNames.set(userId, resolved ?? null);
        } catch {
          resolvedNames.set(userId, null);
        }
      }),
    );
  }

  return text.replaceAll(
    SLACK_USER_MENTION_TOKEN_RE,
    (token, userId: string, inlineLabel: string | undefined) => {
      if (normalizeOptionalString(userId) === botUserId) {
        return token;
      }
      const resolvedName = normalizeOptionalString(resolvedNames.get(userId) ?? undefined);
      if (resolvedName) {
        return `@${resolvedName}`;
      }
      const normalizedInlineLabel = normalizeOptionalString(inlineLabel);
      if (normalizedInlineLabel) {
        return `@${normalizedInlineLabel}`;
      }
      return token;
    },
  );
}

async function normalizeOptionalSlackInboundText(
  text: string | undefined,
  params?: {
    botUserId?: string;
    resolveUserName?: (userId: string) => Promise<{ name?: string }>;
  },
): Promise<string | undefined> {
  const normalizedText = normalizeOptionalString(text);
  if (!normalizedText) {
    return undefined;
  }
  return await normalizeSlackInboundMentions(normalizedText, params);
}

function filterInheritedParentFiles(params: {
  files: SlackFile[] | undefined;
  isThreadReply: boolean;
  threadStarter: SlackThreadStarter | null;
}): SlackFile[] | undefined {
  const { files, isThreadReply, threadStarter } = params;
  if (!isThreadReply || !files?.length) {
    return files;
  }
  if (!threadStarter?.files?.length) {
    return files;
  }
  const starterFileIds = new Set(threadStarter.files.map((file) => file.id));
  const filtered = files.filter((file) => !file.id || !starterFileIds.has(file.id));
  if (filtered.length < files.length) {
    logVerbose(
      `slack: filtered ${files.length - filtered.length} inherited parent file(s) from thread reply`,
    );
  }
  return filtered.length > 0 ? filtered : undefined;
}

export async function resolveSlackMessageContent(params: {
  message: SlackMessageEvent;
  isThreadReply: boolean;
  threadStarter: SlackThreadStarter | null;
  isBotMessage: boolean;
  botToken: string;
  botUserId?: string;
  mediaMaxBytes: number;
  resolveUserName?: (userId: string) => Promise<{ name?: string }>;
}): Promise<SlackResolvedMessageContent | null> {
  const ownFiles = filterInheritedParentFiles({
    files: params.message.files,
    isThreadReply: params.isThreadReply,
    threadStarter: params.threadStarter,
  });

  const media = await resolveSlackMedia({
    files: ownFiles,
    token: params.botToken,
    maxBytes: params.mediaMaxBytes,
  });

  const attachmentContent = await resolveSlackAttachmentContent({
    attachments: params.message.attachments,
    token: params.botToken,
    maxBytes: params.mediaMaxBytes,
  });

  const mergedMedia = [...(media ?? []), ...(attachmentContent?.media ?? [])];
  const effectiveDirectMedia = mergedMedia.length > 0 ? mergedMedia : null;
  const mediaPlaceholder = effectiveDirectMedia
    ? effectiveDirectMedia.map((item) => item.placeholder).join(" ")
    : undefined;

  const fallbackFiles = ownFiles ?? [];
  const fileOnlyFallback =
    !mediaPlaceholder && fallbackFiles.length > 0
      ? fallbackFiles
          .slice(0, MAX_SLACK_MEDIA_FILES)
          .map((file) => normalizeOptionalString(file.name) ?? "file")
          .join(", ")
      : undefined;
  const fileOnlyPlaceholder = fileOnlyFallback ? `[Slack file: ${fileOnlyFallback}]` : undefined;

  const botAttachmentText =
    params.isBotMessage && !attachmentContent?.text
      ? (params.message.attachments ?? [])
          .map(
            (attachment) =>
              normalizeOptionalString(attachment.text) ??
              normalizeOptionalString(attachment.fallback),
          )
          .filter(Boolean)
          .join("\n")
      : undefined;

  const normalizedMessageText = await normalizeOptionalSlackInboundText(
    params.message.text,
    {
      botUserId: params.botUserId,
      resolveUserName: params.resolveUserName,
    },
  );
  const normalizedAttachmentText = await normalizeOptionalSlackInboundText(
    attachmentContent?.text,
    {
      botUserId: params.botUserId,
      resolveUserName: params.resolveUserName,
    },
  );
  const normalizedBotAttachmentText = await normalizeOptionalSlackInboundText(
    botAttachmentText,
    {
      botUserId: params.botUserId,
      resolveUserName: params.resolveUserName,
    },
  );

  const rawBody =
    [
      normalizedMessageText,
      normalizedAttachmentText,
      normalizedBotAttachmentText,
      mediaPlaceholder,
      fileOnlyPlaceholder,
    ]
      .filter(Boolean)
      .join("\n") || "";
  if (!rawBody) {
    return null;
  }

  return {
    rawBody,
    effectiveDirectMedia,
  };
}
