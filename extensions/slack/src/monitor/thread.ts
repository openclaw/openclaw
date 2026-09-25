import type { ConversationsRepliesResponse, WebClient as SlackWebClient } from "@slack/web-api";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { formatSlackFileReferenceList } from "../file-reference.js";
import type { SlackAttachment, SlackFile } from "../types.js";
import {
  hasSlackTableBlock,
  isSlackUnfurlAttachment,
  resolveSlackBlocksText,
  resolveSlackMessageText as resolveSharedSlackMessageText,
} from "./block-text.js";
import { resolveSlackTimestampMs } from "./message-handler/timestamp.js";

export type SlackThreadStarter = {
  text: string;
  userId?: string;
  botId?: string;
  ts?: string;
  files?: SlackFile[];
  attachments?: SlackAttachment[];
};

type SlackThreadStarterCacheEntry = {
  value: SlackThreadStarter;
  expiresAt: number;
};

const THREAD_STARTER_CACHE = new Map<string, SlackThreadStarterCacheEntry>();
const THREAD_STARTER_CACHE_TTL_MS = 6 * 60 * 60_000;
const THREAD_STARTER_CACHE_MAX = 2000;

function evictThreadStarterCache(): void {
  const now = asDateTimestampMs(Date.now());
  if (now === undefined) {
    THREAD_STARTER_CACHE.clear();
    return;
  }
  for (const [cacheKey, entry] of THREAD_STARTER_CACHE.entries()) {
    if (asDateTimestampMs(entry.expiresAt) === undefined || entry.expiresAt <= now) {
      THREAD_STARTER_CACHE.delete(cacheKey);
    }
  }
  pruneMapToMaxSize(THREAD_STARTER_CACHE, THREAD_STARTER_CACHE_MAX);
}

function formatSlackFilePlaceholder(files: SlackFile[] | undefined): string {
  return `[attached: ${formatSlackFileReferenceList(files)}]`;
}

function pushUniqueText(
  parts: string[],
  value: string | undefined,
  options: { preserveWhitespace?: boolean } = {},
): void {
  const text = options.preserveWhitespace
    ? typeof value === "string" && value.trim().length > 0
      ? value
      : undefined
    : normalizeOptionalString(value);
  if (text && !parts.includes(text)) {
    parts.push(text);
  }
}

function resolveSlackAttachmentFallbackText(
  attachments: SlackAttachment[] | undefined,
): string | undefined {
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return undefined;
  }

  const parts: string[] = [];
  for (const attachment of attachments) {
    const excludeTableBlocks = isSlackUnfurlAttachment(attachment);
    const fallbackBlocks = (blocks: unknown[] | undefined) =>
      excludeTableBlocks ? blocks?.filter((block) => !hasSlackTableBlock([block])) : blocks;
    pushUniqueText(parts, attachment.pretext);
    pushUniqueText(parts, attachment.title);
    pushUniqueText(parts, attachment.text);
    const isTablePlaceholder =
      hasSlackTableBlock(attachment.blocks) &&
      normalizeOptionalString(attachment.fallback) === "[no preview available]";
    if (!isTablePlaceholder) {
      pushUniqueText(parts, attachment.fallback);
    }
    for (const field of attachment.fields ?? []) {
      pushUniqueText(parts, field.title);
      pushUniqueText(parts, field.value);
    }
    pushUniqueText(parts, resolveSlackBlocksText(fallbackBlocks(attachment.blocks))?.text, {
      preserveWhitespace: true,
    });
    pushUniqueText(parts, resolveSlackBlocksText(fallbackBlocks(attachment.message_blocks))?.text, {
      preserveWhitespace: true,
    });
  }
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function resolveSlackMessageText(message: {
  text?: string;
  blocks?: unknown[];
  attachments?: SlackAttachment[];
}): string | undefined {
  const messageText =
    normalizeOptionalString(message.text) ??
    resolveSlackAttachmentFallbackText(message.attachments) ??
    (message.attachments?.some(
      (attachment) =>
        attachment.is_share === true &&
        (normalizeOptionalString(attachment.image_url) || attachment.files?.length),
    )
      ? "[Slack media attachment]"
      : undefined);
  return resolveSharedSlackMessageText(
    { ...message, text: messageText },
    { preserveMessageTextWhitespace: true },
  );
}

export async function resolveSlackThreadStarter(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
  workspaceScope: { accountId: string; teamId: string };
  refresh?: boolean;
}): Promise<SlackThreadStarter | null> {
  evictThreadStarterCache();
  const cacheKey = JSON.stringify([
    params.workspaceScope.accountId,
    params.workspaceScope.teamId,
    params.channelId,
    params.threadTs,
  ]);
  const cached = THREAD_STARTER_CACHE.get(cacheKey);
  if (cached && !params.refresh) {
    const now = asDateTimestampMs(Date.now());
    if (now !== undefined && cached.expiresAt > now) {
      return cached.value;
    }
    THREAD_STARTER_CACHE.delete(cacheKey);
  }
  if (params.refresh) {
    THREAD_STARTER_CACHE.delete(cacheKey);
  }
  try {
    const response = await params.client.conversations.replies({
      channel: params.channelId,
      ts: params.threadTs,
      limit: 1,
      inclusive: true,
    });
    const message = response?.messages?.[0];
    const text = message ? resolveSlackMessageText(message) : undefined;
    const files = message?.files?.length ? message.files : undefined;
    if (!message || (!text && !files)) {
      return null;
    }
    const starter: SlackThreadStarter = {
      text: text || formatSlackFilePlaceholder(files),
      userId: message.user,
      botId: message.bot_id,
      ts: message.ts,
      files,
    };
    const expiresAt = resolveExpiresAtMsFromDurationMs(THREAD_STARTER_CACHE_TTL_MS);
    if (expiresAt !== undefined) {
      if (THREAD_STARTER_CACHE.has(cacheKey)) {
        THREAD_STARTER_CACHE.delete(cacheKey);
      }
      THREAD_STARTER_CACHE.set(cacheKey, {
        value: starter,
        expiresAt,
      });
      evictThreadStarterCache();
    }
    return starter;
  } catch (err) {
    logVerbose(
      `slack thread starter fetch failed channel=${params.channelId} ts=${params.threadTs}: ${formatErrorMessage(err)}`,
    );
    return null;
  }
}

type SlackRepliesPageMessage = NonNullable<ConversationsRepliesResponse["messages"]>[number];

const SLACK_THREAD_HISTORY_MAX_PAGES = 3;

/**
 * Fetches the most recent messages in a Slack thread (excluding the current message).
 * Used to populate thread context when a new thread session starts.
 *
 * Uses cursor pagination and keeps only the latest N retained messages when the full
 * thread fits in the bounded fetch window.
 */
export async function resolveSlackThreadHistory(params: {
  channelId: string;
  threadTs: string;
  client: SlackWebClient;
  currentMessageTs?: string;
  limit?: number;
  oldest?: string;
  excludedMessageIds?: ReadonlySet<string>;
  onOmission?: (reason: string) => void;
  assertCurrent?: () => void;
}): Promise<SlackThreadStarter[]> {
  const maxMessages = params.limit ?? 20;
  if (!Number.isFinite(maxMessages) || maxMessages <= 0) {
    return [];
  }

  // Slack recommends no more than 200 per page.
  const fetchLimit = 200;
  const retained: Array<[message: SlackRepliesPageMessage, text: string | undefined]> = [];
  let cursor: string | undefined;
  let pagesFetched = 0;

  try {
    do {
      pagesFetched += 1;
      params.assertCurrent?.();
      const response = await params.client.conversations.replies({
        channel: params.channelId,
        ts: params.threadTs,
        limit: fetchLimit,
        inclusive: false,
        ...(params.currentMessageTs ? { latest: params.currentMessageTs } : {}),
        ...(params.oldest ? { oldest: params.oldest } : {}),
        ...(cursor ? { cursor } : {}),
      });
      params.assertCurrent?.();

      for (const msg of response.messages ?? []) {
        const timestamp = resolveSlackTimestampMs(msg.ts);
        const text = resolveSlackMessageText(msg);
        // Keep messages with text, Slack attachment/block fallback text, or file attachments.
        if (!text && !msg.files?.length) {
          continue;
        }
        if (
          !msg.ts ||
          msg.ts === params.currentMessageTs ||
          (params.currentMessageTs &&
            timestamp !== undefined &&
            Number(msg.ts) >= Number(params.currentMessageTs)) ||
          (params.oldest && (timestamp === undefined || Number(msg.ts) <= Number(params.oldest))) ||
          params.excludedMessageIds?.has(msg.ts)
        ) {
          continue;
        }
        if (retained.some(([entry]) => entry.ts === msg.ts)) {
          continue;
        }
        retained.push([msg, text]);
      }
      if (retained.length > maxMessages) {
        retained.splice(0, retained.length - maxMessages);
      }

      const next = response.response_metadata?.next_cursor;
      cursor = typeof next === "string" && next.trim().length > 0 ? next.trim() : undefined;
      if (response.has_more && !cursor) {
        params.onOmission?.("Slack returned an incomplete thread page without a cursor");
        return [];
      }
      // Slack replies paginate oldest to newest with no reverse cursor; cap cold
      // thread seeding so pathological long threads cannot block dispatch.
    } while (cursor && pagesFetched < SLACK_THREAD_HISTORY_MAX_PAGES);

    if (cursor) {
      logVerbose(
        `slack thread history capped channel=${params.channelId} ts=${params.threadTs} pages=${SLACK_THREAD_HISTORY_MAX_PAGES}`,
      );
      params.onOmission?.("Slack thread exceeds the three-page automatic history budget");
      return [];
    }

    return retained.map(([message, text]) => ({
      // For file-only messages, create a placeholder showing attached filenames.
      text: text ?? formatSlackFilePlaceholder(message.files),
      userId: message.user,
      botId: message.bot_id,
      ts: message.ts,
      files: message.files,
      attachments: message.attachments,
    }));
  } catch (err) {
    params.assertCurrent?.();
    params.onOmission?.(formatErrorMessage(err));
    logVerbose(
      `slack thread history fetch failed channel=${params.channelId} ts=${params.threadTs}: ${formatErrorMessage(err)}`,
    );
    return [];
  }
}

/** Slack channel history is newest first, unlike chronological thread replies. */
export async function resolveSlackChannelHistory(params: {
  channelId: string;
  client: SlackWebClient;
  currentMessageTs: string;
  oldest?: string;
  excludedMessageIds: ReadonlySet<string>;
  limit: number;
  assertCurrent?: () => void;
}): Promise<SlackThreadStarter[]> {
  if (!Number.isFinite(params.limit) || params.limit <= 0) {
    return [];
  }
  const messages: SlackThreadStarter[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  let scanned = 0;
  // Budget pages from the configured window, never traverse to fill policy-filtered gaps.
  const maxPages = Math.ceil(params.limit / 200);
  for (let page = 0; page < maxPages; page += 1) {
    params.assertCurrent?.();
    const response = await params.client.conversations.history({
      channel: params.channelId,
      latest: params.currentMessageTs,
      ...(params.oldest ? { oldest: params.oldest } : {}),
      inclusive: false,
      limit: Math.min(200, params.limit - scanned),
      ...(cursor ? { cursor } : {}),
    });
    params.assertCurrent?.();
    for (const message of response.messages ?? []) {
      scanned += 1;
      if (
        !message.ts ||
        Number(message.ts) >= Number(params.currentMessageTs) ||
        (params.oldest && Number(message.ts) <= Number(params.oldest)) ||
        params.excludedMessageIds.has(message.ts) ||
        seen.has(message.ts)
      ) {
        continue;
      }
      seen.add(message.ts);
      const text = resolveSlackMessageText(message);
      if (!text && !message.files?.length) {
        continue;
      }
      messages.push({
        text: text ?? formatSlackFilePlaceholder(message.files),
        userId: message.user,
        botId: message.bot_id,
        ts: message.ts,
        files: message.files,
        attachments: message.attachments,
      });
    }
    cursor = response.response_metadata?.next_cursor?.trim() || undefined;
    if (!cursor || scanned >= params.limit) {
      break;
    }
  }
  return messages.slice(0, params.limit).toReversed();
}
