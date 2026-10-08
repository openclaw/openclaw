import type { APIChannel, APIGuildForumChannel, APIGuildMediaChannel } from "discord-api-types/v10";
import { ChannelType, Routes } from "discord-api-types/v10";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import type { PollInput } from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveChunkMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { createThread } from "./internal/discord.js";
import { withDiscordRequestAuthority } from "./internal/request-authority.js";
import { rewriteDiscordKnownMentions } from "./mentions.js";
import { prepareDiscordOutboundText } from "./outbound-text.js";
import { parseAndResolveChannelRecipient } from "./recipient-resolution.js";
import {
  createReusableDiscordReplyReference,
  type DiscordReplyReference,
} from "./reply-reference.js";
import { createDiscordSendReceiptFromResults, createDiscordSendResult } from "./send.receipt.js";
import {
  buildDiscordMessageRequest,
  buildDiscordSendError,
  buildDiscordTextChunks,
  createDiscordClient,
  createDiscordMessageNonce,
  normalizeDiscordPollInput,
  normalizeStickerIds,
  resolveDiscordMessageFlags,
  resolveDiscordSuppressEmbeds,
  resolveChannelId,
  resolveDiscordChannel,
  resolveDiscordSendComponents,
  resolveDiscordSendEmbeds,
  sendDiscordMedia,
  sendDiscordText,
  type DiscordAllowedMentions,
  type DiscordSendProgress,
  type DiscordSendEmbeds,
} from "./send.shared.js";
import type {
  DiscordOutboundMediaOpts,
  DiscordReactOpts,
  DiscordSendResult,
} from "./send.types.js";
type DiscordSendOpts = Omit<DiscordReactOpts, "signal" | "timeoutMs"> &
  DiscordOutboundMediaOpts & {
    mediaUrl?: string;
    filename?: string;
    reply?: DiscordReplyReference;
    textLimit?: number;
    maxLinesPerMessage?: number;
    tableMode?: MarkdownTableMode;
    chunkMode?: ChunkMode;
    components?: Parameters<typeof resolveDiscordSendComponents>[0]["components"];
    embeds?: DiscordSendEmbeds;
    silent?: boolean;
    threadId?: string | number;
    suppressEmbeds?: boolean;
    allowedMentions?: DiscordAllowedMentions;
    /** Persist each concrete platform send before any later chunk can fail. */
    onDeliveryResult?: (result: DiscordSendResult) => Promise<void> | void;
    /** @internal Refresh durable custody immediately before Discord REST I/O. */
    onPlatformSendDispatch?: () => Promise<void>;
    /** @internal Synchronously fence custody after refresh and immediately before Discord REST I/O. */
    assertPlatformSendAuthorized?: () => void;
  };

const DEFAULT_DISCORD_MEDIA_MAX_MB = 100;
/** Discord's ChannelFlags.RequireTag is bit 4 on forum/media parent channels. */
const DISCORD_FORUM_REQUIRE_TAG_FLAG = 1 << 4;

/** Discord thread names are capped at 100 characters. */
const DISCORD_THREAD_NAME_LIMIT = 100;

/** Derive a thread title from the first non-empty line of the message text. */
function deriveForumThreadName(text: string): string {
  const firstLine =
    normalizeOptionalString(text.split("\n").find((line) => normalizeOptionalString(line))) ?? "";
  return (
    truncateUtf16Safe(firstLine, DISCORD_THREAD_NAME_LIMIT) || new Date().toISOString().slice(0, 16)
  );
}

/** Forum/Media channels cannot receive regular messages; detect them here. */
function isForumLikeChannel(
  channel?: APIChannel,
): channel is APIGuildForumChannel | APIGuildMediaChannel {
  return channel?.type === ChannelType.GuildForum || channel?.type === ChannelType.GuildMedia;
}

export async function sendMessageDiscord(
  to: string,
  text: string,
  opts: DiscordSendOpts,
): Promise<DiscordSendResult> {
  // The REST scheduler can retry after this sender's last handoff check.
  return await withDiscordRequestAuthority(opts.assertPlatformSendAuthorized, () =>
    sendMessageDiscordInternal(to, text, opts),
  );
}

async function sendMessageDiscordInternal(
  to: string,
  text: string,
  opts: DiscordSendOpts,
): Promise<DiscordSendResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "Discord send");
  const { token, rest, request, account: accountInfo } = createDiscordClient({ ...opts, cfg });
  const chunkMode = opts.chunkMode ?? resolveChunkMode(cfg, "discord", accountInfo.accountId);
  const maxLinesPerMessage = opts.maxLinesPerMessage ?? accountInfo.config.maxLinesPerMessage;
  const suppressEmbeds = resolveDiscordSuppressEmbeds({
    configured: accountInfo.config.suppressEmbeds,
    override: opts.suppressEmbeds,
  });
  const mediaMaxBytes =
    typeof accountInfo.config.mediaMaxMb === "number"
      ? accountInfo.config.mediaMaxMb * 1024 * 1024
      : DEFAULT_DISCORD_MEDIA_MAX_MB * 1024 * 1024;
  const { renderedText, textWithMentions, textLimit } = prepareDiscordOutboundText(text ?? "", {
    cfg,
    account: accountInfo,
    tableMode: opts.tableMode,
    textLimit: opts.textLimit,
  });
  const recipient = await parseAndResolveChannelRecipient(to, cfg, accountInfo.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);

  // Forum/Media channels reject POST /messages; auto-create a thread post instead.
  const channel = await resolveDiscordChannel(rest, channelId);
  const deliveredResults: DiscordSendResult[] = [];
  let deliveryThreadId: string | undefined;
  const reportResult: DiscordSendProgress = async (progressResult, kind, replyToId) => {
    const deliveredResult = createDiscordSendResult({
      result: progressResult,
      fallbackChannelId: deliveryThreadId ?? channelId,
      kind,
      threadId: deliveryThreadId,
      reply: createReusableDiscordReplyReference(replyToId),
    });
    deliveredResults.push(deliveredResult);
    await opts.onDeliveryResult?.(deliveredResult);
  };

  const textSendOptions = {
    rest,
    request,
    maxLinesPerMessage,
    chunkMode,
    silent: opts.silent,
    suppressEmbeds,
    allowedMentions: opts.allowedMentions,
    maxChars: textLimit,
    onResult: reportResult,
    onPlatformSendDispatch: opts.onPlatformSendDispatch,
    assertPlatformSendAuthorized: opts.assertPlatformSendAuthorized,
  };
  const mediaSendOptions = {
    filename: opts.filename,
    mediaAccess: opts.mediaAccess,
    mediaLocalRoots: opts.mediaLocalRoots,
    mediaReadFile: opts.mediaReadFile,
    maxBytes: mediaMaxBytes,
  };

  async function sendWithError<T>(targetChannelId: string, send: () => Promise<T>): Promise<T> {
    try {
      return await send();
    } catch (err) {
      throw await buildDiscordSendError(err, {
        channelId: targetChannelId,
        cfg,
        rest,
        token,
        hasMedia: Boolean(opts.mediaUrl),
      });
    }
  }

  if (isForumLikeChannel(channel)) {
    if (((channel.flags ?? 0) & DISCORD_FORUM_REQUIRE_TAG_FLAG) !== 0) {
      throw new Error(
        `Discord forum channel ${channelId} requires an applied tag; use thread-create with appliedTags, then send to the created thread.`,
      );
    }
    const threadName = deriveForumThreadName(renderedText);
    const chunks = buildDiscordTextChunks(textWithMentions, {
      maxLinesPerMessage,
      chunkMode,
      maxChars: textLimit,
    });
    const starterContent = chunks[0]?.trim() ? chunks[0] : threadName;
    const starterComponents = resolveDiscordSendComponents({
      components: opts.components,
      text: starterContent,
      isFirst: true,
    });
    const starterEmbeds = resolveDiscordSendEmbeds({ embeds: opts.embeds, isFirst: true });
    const starterFlags = resolveDiscordMessageFlags({
      silent: opts.silent,
      suppressEmbeds: suppressEmbeds && !starterEmbeds?.length,
    });
    const starterBody = buildDiscordMessageRequest({
      endpoint: "forum-thread",
      text: starterContent,
      components: starterComponents,
      embeds: starterEmbeds,
      flags: starterFlags,
      allowedMentions: opts.allowedMentions,
    });
    const threadRes = await sendWithError(channelId, () =>
      request(
        async () => {
          await opts.onPlatformSendDispatch?.();
          opts.assertPlatformSendAuthorized?.();
          return createThread<{ id: string; message?: { id: string; channel_id: string } }>(
            rest,
            channelId,
            {
              body: {
                name: threadName,
                // Discord clients preselect the parent default; the REST endpoint otherwise
                // falls back to 4320 minutes, so carry the fetched parent value explicitly.
                ...(channel.default_auto_archive_duration === undefined
                  ? {}
                  : { auto_archive_duration: channel.default_auto_archive_duration }),
                message: starterBody,
              },
            },
          );
        },
        "forum-thread",
        { safety: "non-idempotent-create" },
      ),
    );

    const threadId = threadRes.id;
    deliveryThreadId = threadId;
    const messageId = threadRes.message?.id ?? threadId;
    const resultChannelId = threadRes.message?.channel_id ?? threadId;
    const remainingChunks = chunks.slice(1);
    const starterResult = createDiscordSendResult({
      result: {
        id: messageId,
        channel_id: resultChannelId,
      },
      fallbackChannelId: channelId,
      kind: "text",
      threadId,
    });
    deliveredResults.push(starterResult);
    await opts.onDeliveryResult?.(starterResult);

    await sendWithError(threadId, async () => {
      let textChunks = remainingChunks;
      if (opts.mediaUrl) {
        const [mediaCaption, ...afterMediaChunks] = remainingChunks;
        await sendDiscordMedia({
          ...textSendOptions,
          ...mediaSendOptions,
          channelId: threadId,
          text: mediaCaption ?? "",
          mediaUrl: opts.mediaUrl,
        });
        textChunks = afterMediaChunks;
      }
      for (const chunk of textChunks) {
        await sendDiscordText({ ...textSendOptions, channelId: threadId, text: chunk });
      }
    });

    recordChannelActivity({
      channel: "discord",
      accountId: accountInfo.accountId,
      direction: "outbound",
    });
    return {
      ...starterResult,
      receipt: createDiscordSendReceiptFromResults({ results: deliveredResults, threadId }),
    };
  }

  const result = await sendWithError(channelId, async () => {
    const message = {
      ...textSendOptions,
      channelId,
      text: textWithMentions,
      reply: opts.reply,
      components: opts.components,
      embeds: opts.embeds,
    };
    return opts.mediaUrl
      ? await sendDiscordMedia({ ...message, ...mediaSendOptions, mediaUrl: opts.mediaUrl })
      : await sendDiscordText(message);
  });

  recordChannelActivity({
    channel: "discord",
    accountId: accountInfo.accountId,
    direction: "outbound",
  });
  return {
    ...createDiscordSendResult({ result, fallbackChannelId: channelId, kind: "text" }),
    receipt: createDiscordSendReceiptFromResults({ results: deliveredResults }),
  };
}

export async function sendStickerDiscord(
  to: string,
  stickerIds: string[],
  opts: DiscordSendOpts & { content?: string },
): Promise<DiscordSendResult> {
  return sendDiscordStructuredMessage(to, opts, "sticker", () => ({
    sticker_ids: normalizeStickerIds(stickerIds),
  }));
}

export async function sendPollDiscord(
  to: string,
  poll: PollInput,
  opts: DiscordSendOpts & { content?: string },
): Promise<DiscordSendResult> {
  return sendDiscordStructuredMessage(to, opts, "poll", () => {
    if (poll.durationSeconds !== undefined) {
      throw new Error("Discord polls do not support durationSeconds; use durationHours");
    }
    return { poll: normalizeDiscordPollInput(poll) };
  });
}

async function sendDiscordStructuredMessage(
  to: string,
  opts: DiscordSendOpts & { content?: string },
  kind: "poll" | "sticker",
  buildPayload: () => Record<string, unknown>,
): Promise<DiscordSendResult> {
  return withDiscordRequestAuthority(opts.assertPlatformSendAuthorized, async () => {
    const cfg = requireRuntimeConfig(opts.cfg, "Discord structured send");
    const { rest, request, account } = createDiscordClient({ ...opts, cfg });
    const recipient = await parseAndResolveChannelRecipient(to, cfg, account.accountId);
    const { channelId } = await resolveChannelId(rest, recipient, request);
    const content = opts.content?.trim()
      ? rewriteDiscordKnownMentions(opts.content, {
          accountId: account.accountId,
          mentionAliases: account.config.mentionAliases,
        })
      : undefined;
    const suppressEmbeds = resolveDiscordSuppressEmbeds({
      configured: account.config.suppressEmbeds,
      override: opts.suppressEmbeds,
    });
    const payload = buildPayload();
    const flags = resolveDiscordMessageFlags({ silent: opts.silent, suppressEmbeds });
    const body = {
      content: content || undefined,
      ...payload,
      nonce: createDiscordMessageNonce(),
      enforce_nonce: true,
      ...(flags ? { flags } : {}),
    };
    const result = await request(
      async () => {
        await opts.onPlatformSendDispatch?.();
        opts.assertPlatformSendAuthorized?.();
        // SAFETY: Discord's Create Message response includes its message and channel IDs.
        return (await rest.post(Routes.channelMessages(channelId), { body })) as {
          id: string;
          channel_id: string;
        };
      },
      kind,
      { safety: "nonce-protected-create" },
    );
    recordChannelActivity({
      channel: "discord",
      accountId: account.accountId,
      direction: "outbound",
    });
    return createDiscordSendResult({
      result,
      fallbackChannelId: channelId,
      kind: kind === "poll" ? "poll" : "card",
      threadId: kind === "poll" ? opts.threadId : undefined,
    });
  });
}
