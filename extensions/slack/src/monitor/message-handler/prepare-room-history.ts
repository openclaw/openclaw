import { toInboundMediaFactsWithMetadata } from "openclaw/plugin-sdk/channel-inbound";
import type { ContextVisibilityMode } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { mimeTypeFromFilePath } from "openclaw/plugin-sdk/media-mime";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { shouldIncludeSupplementalContext } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SlackAttachment, SlackFile, SlackMessageEvent } from "../../types.js";
import { resolveSlackUserAllowed } from "../allow-list.js";
import type { SlackMonitorContext } from "../context.js";
import type { SlackEventScope } from "../event-scope.js";
import { resolveSlackChannelHistory, resolveSlackThreadHistory } from "../thread.js";
import { resolveSlackMessageContent } from "./prepare-content.js";
import { isSlackThreadAuthorCurrentBot } from "./prepare-thread-context-root.js";
import { resolveSlackTimestampMs } from "./timestamp.js";

const SLACK_HISTORY_MEDIA_MAX_ATTACHMENTS = 4;
const SLACK_HISTORY_MEDIA_MAX_BYTES = 10 * 1024 * 1024;
const SLACK_HISTORY_MEDIA_IDLE_TIMEOUT_MS = 1_000;
const SLACK_HISTORY_MEDIA_TOTAL_TIMEOUT_MS = 3_000;

export async function resolveSlackRoomHistory(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  threadTs?: string;
  oldest?: string;
  excludedMessageIds: ReadonlySet<string>;
  allowFromLower: string[];
  contextVisibilityMode: ContextVisibilityMode;
  eventScope?: SlackEventScope;
  assertCurrent: () => void;
  abortSignal?: AbortSignal;
}): Promise<HistoryEntry[]> {
  if (params.ctx.historyLimit <= 0 || !params.message.ts) {
    return [];
  }
  const warnOmission = (reason: string) => {
    params.ctx.logger.warn(
      {
        accountId: params.ctx.accountId,
        teamId: params.eventScope?.teamId ?? params.ctx.teamId,
        channelId: params.message.channel,
        threadTs: params.threadTs,
        reason,
      },
      "Slack automatic history omitted",
    );
  };
  try {
    params.assertCurrent();
    const request = {
      channelId: params.message.channel,
      client: params.eventScope?.client ?? params.ctx.app.client,
      currentMessageTs: params.message.ts,
      oldest: params.oldest,
      excludedMessageIds: params.excludedMessageIds,
      limit: Math.max(DEFAULT_GROUP_HISTORY_LIMIT, params.ctx.historyLimit),
      assertCurrent: params.assertCurrent,
    };
    const messages = params.threadTs
      ? await resolveSlackThreadHistory({
          ...request,
          threadTs: params.threadTs,
          onOmission: warnOmission,
        })
      : await resolveSlackChannelHistory(request);
    params.assertCurrent();
    const permitted: Array<{ message: (typeof messages)[number]; sender: string }> = [];
    for (const message of messages) {
      if (isSlackThreadAuthorCurrentBot({ identity: params.ctx, author: message })) {
        continue;
      }
      const user = message.userId
        ? await params.ctx.resolveUserName(message.userId, params.eventScope)
        : undefined;
      params.assertCurrent();
      const senderAllowed = resolveSlackUserAllowed({
        allowList: params.allowFromLower,
        teamId: params.eventScope?.teamId ?? params.ctx.teamId,
        userId: message.userId ?? message.botId,
        userName: user?.name,
        allowNameMatching: params.ctx.allowNameMatching,
      });
      if (
        !shouldIncludeSupplementalContext({
          mode: params.contextVisibilityMode,
          kind: "history",
          senderAllowed,
        })
      ) {
        continue;
      }
      permitted.push({
        message,
        sender: user?.name ?? message.userId ?? `Bot (${message.botId ?? "unknown"})`,
      });
    }
    const entries: HistoryEntry[] = [];
    let mediaRemaining = SLACK_HISTORY_MEDIA_MAX_ATTACHMENTS;
    for (const { message, sender } of permitted.slice(-params.ctx.historyLimit)) {
      // Keep media on the same native snapshot as text, including edits and deletions.
      const { media, attempted } =
        mediaRemaining > 0 && (message.files?.length || message.attachments?.length)
          ? await resolveSlackHistoryMedia({
              ctx: params.ctx,
              eventScope: params.eventScope,
              maxAttachments: mediaRemaining,
              assertCurrent: params.assertCurrent,
              abortSignal: params.abortSignal,
              message: {
                type: "message",
                channel: params.message.channel,
                ts: message.ts,
                user: message.userId,
                bot_id: message.botId,
                text: message.text,
                files: message.files,
                attachments: message.attachments,
              },
            })
          : { media: [], attempted: 0 };
      params.assertCurrent();
      mediaRemaining -= attempted;
      entries.push({
        sender,
        body: message.text,
        timestamp: resolveSlackTimestampMs(message.ts),
        messageId: message.ts,
        ...(media.length > 0 ? { media } : {}),
      });
    }
    return entries;
  } catch (error) {
    warnOmission(formatErrorMessage(error));
    return [];
  }
}

function isSlackImageFileCandidate(file: SlackFile): boolean {
  const mime = file.mimetype?.split(";")[0]?.trim().toLowerCase();
  if (mime?.startsWith("image/")) {
    return true;
  }
  return Boolean(mimeTypeFromFilePath(file.name)?.startsWith("image/"));
}

function sliceSlackImageFileCandidates(files: SlackFile[] | undefined, limit: number): SlackFile[] {
  if (limit <= 0 || !files?.length) {
    return [];
  }
  return files.filter(isSlackImageFileCandidate).slice(0, limit);
}

function sliceSlackHistoryAttachmentCandidates(
  attachments: SlackAttachment[] | undefined,
  limit: number,
): SlackAttachment[] {
  if (limit <= 0 || !attachments?.length) {
    return [];
  }
  const out: SlackAttachment[] = [];
  let remaining = limit;
  for (const attachment of attachments) {
    if (attachment.is_share !== true) {
      continue;
    }
    const hasImageUrl = Boolean(normalizeOptionalString(attachment.image_url));
    const files = sliceSlackImageFileCandidates(
      attachment.files,
      remaining - (hasImageUrl ? 1 : 0),
    );
    if (!hasImageUrl && files.length === 0) {
      continue;
    }
    out.push({ ...attachment, files });
    remaining -= (hasImageUrl ? 1 : 0) + files.length;
    if (remaining <= 0) {
      break;
    }
  }
  return out;
}

function buildSlackHistoryMediaCandidateMessage(
  message: SlackMessageEvent,
  maxAttachments: number,
): { message: SlackMessageEvent; attempted: number } | null {
  const files = sliceSlackImageFileCandidates(message.files, maxAttachments);
  const attachments = sliceSlackHistoryAttachmentCandidates(
    message.attachments,
    Math.max(0, maxAttachments - files.length),
  );
  if (files.length === 0 && attachments.length === 0) {
    return null;
  }
  return {
    message: { ...message, files, attachments },
    attempted:
      files.length +
      attachments.reduce(
        (count, attachment) =>
          count +
          (normalizeOptionalString(attachment.image_url) ? 1 : 0) +
          (attachment.files?.length ?? 0),
        0,
      ),
  };
}

async function resolveSlackHistoryMedia(params: {
  ctx: SlackMonitorContext;
  message: SlackMessageEvent;
  eventScope?: SlackEventScope;
  maxAttachments: number;
  assertCurrent: () => void;
  abortSignal?: AbortSignal;
}) {
  const candidate = buildSlackHistoryMediaCandidateMessage(params.message, params.maxAttachments);
  if (!candidate) {
    return { media: [], attempted: 0 };
  }
  const content = await resolveSlackMessageContent({
    message: candidate.message,
    isThreadReply: false,
    threadStarter: null,
    isBotMessage: Boolean(params.message.bot_id),
    client: params.eventScope?.client ?? params.ctx.app.client,
    botToken: params.ctx.botToken,
    mediaMaxBytes: Math.min(params.ctx.mediaMaxBytes, SLACK_HISTORY_MEDIA_MAX_BYTES),
    mediaReadIdleTimeoutMs: SLACK_HISTORY_MEDIA_IDLE_TIMEOUT_MS,
    mediaTotalTimeoutMs: SLACK_HISTORY_MEDIA_TOTAL_TIMEOUT_MS,
    assertCurrent: params.assertCurrent,
    abortSignal: params.abortSignal,
  });
  return {
    media: await toInboundMediaFactsWithMetadata(content?.effectiveDirectMedia, {
      kind: "image",
      messageId: params.message.ts,
    }),
    attempted: candidate.attempted,
  };
}
