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

const SLACK_USER_MENTION_TOKEN_RE = /<@([A-Z0-9]+)(?:\|([^>]+))?>/gi;

async function normalizeSlackInboundMentions(
  text: string,
  resolveUserName?: (userId: string) => Promise<{ name?: string }>,
): Promise<string> {
  if (!text.includes("<@")) {
    return text;
  }

  const matches = [...text.matchAll(SLACK_USER_MENTION_TOKEN_RE)];
  if (matches.length === 0) {
    return text;
  }

  const resolvedNames = new Map<string, string | null>();
  if (resolveUserName) {
    const uniqueIds = [...new Set(matches.map((match) => match[1] ?? "").filter(Boolean))];
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

  const rawBody =
    [
      normalizeOptionalString(params.message.text),
      attachmentContent?.text,
      botAttachmentText,
      mediaPlaceholder,
      fileOnlyPlaceholder,
    ]
      .filter(Boolean)
      .join("\n") || "";
  if (!rawBody) {
    return null;
  }

  return {
    rawBody: await normalizeSlackInboundMentions(rawBody, params.resolveUserName),
    effectiveDirectMedia,
  };
}
