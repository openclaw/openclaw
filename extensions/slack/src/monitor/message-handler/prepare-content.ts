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

  const renderSlackUserMentions = async (text: string | undefined): Promise<string | undefined> => {
    const pattern = /<@([A-Z0-9]+)(?:\|[^>]+)?>/gi;
    if (!text || !params.resolveUserName || !pattern.test(text)) {
      return text;
    }
    pattern.lastIndex = 0;
    const seen = new Map<string, string | null>();
    for (const match of text.matchAll(pattern)) {
      const userId = match[1];
      if (!userId || seen.has(userId)) {
        continue;
      }
      const user = await params.resolveUserName(userId);
      const renderedName = normalizeOptionalString(user?.name);
      seen.set(userId, renderedName ? `<@${userId}> (${renderedName})` : null);
    }
    if (seen.size === 0) {
      return text;
    }
    pattern.lastIndex = 0;
    return text.replace(pattern, (full, userId: string) => {
      const rendered = seen.get(userId);
      return rendered ?? full;
    });
  };

  const renderedMessageText = await renderSlackUserMentions(
    normalizeOptionalString(params.message.text),
  );
  const renderedAttachmentText = await renderSlackUserMentions(attachmentContent?.text);
  const renderedBotAttachmentText = await renderSlackUserMentions(botAttachmentText);

  const rawBody =
    [
      renderedMessageText,
      renderedAttachmentText,
      renderedBotAttachmentText,
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
