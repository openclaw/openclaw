// Discord plugin module implements send.outbound behavior.
import type { APIChannel, APIGuildForumChannel, APIGuildMediaChannel } from "discord-api-types/v10";
import { ChannelType } from "discord-api-types/v10";
import { fromMarkdown } from "mdast-util-from-markdown";
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import type { MarkdownTableMode, OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import type { OutboundMediaAccess, PollInput } from "openclaw/plugin-sdk/media-runtime";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveChunkMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import type { RetryConfig } from "openclaw/plugin-sdk/retry-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  convertMarkdownTables,
  type FormatCapabilityProfile,
  renderMarkdownWithMarkers,
} from "openclaw/plugin-sdk/text-chunking";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveDiscordAccount } from "./accounts.js";
import { createChannelMessage, createThread, type RequestClient } from "./internal/discord.js";
import { rewriteDiscordKnownMentions } from "./mentions.js";
import { parseAndResolveChannelRecipient } from "./recipient-resolution.js";
import {
  createReusableDiscordReplyReference,
  type DiscordReplyReference,
} from "./reply-reference.js";
import { createDiscordSendResult, type DiscordReceiptResultSource } from "./send.receipt.js";
import {
  buildDiscordMessageRequest,
  buildDiscordSendError,
  buildDiscordTextChunks,
  createDiscordClient,
  createDiscordMessageNonce,
  normalizeDiscordPollInput,
  normalizeStickerIds,
  resolveDiscordMessageFlags,
  resolveChannelId,
  resolveDiscordChannel,
  resolveDiscordSendComponents,
  resolveDiscordSendEmbeds,
  sendDiscordMedia,
  sendDiscordText,
  type DiscordAllowedMentions,
  type DiscordSendProgress,
  type DiscordSendComponents,
  type DiscordSendEmbeds,
} from "./send.shared.js";
import type { DiscordSendResult } from "./send.types.js";
type DiscordSendOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  mediaUrl?: string;
  filename?: string;
  mediaAccess?: OutboundMediaAccess;
  mediaLocalRoots?: readonly string[];
  mediaReadFile?: (filePath: string) => Promise<Buffer>;
  verbose?: boolean;
  rest?: RequestClient;
  reply?: DiscordReplyReference;
  retry?: RetryConfig;
  textLimit?: number;
  maxLinesPerMessage?: number;
  tableMode?: MarkdownTableMode;
  chunkMode?: ChunkMode;
  components?: DiscordSendComponents;
  embeds?: DiscordSendEmbeds;
  silent?: boolean;
  suppressEmbeds?: boolean;
  allowedMentions?: DiscordAllowedMentions;
  /** Persist each concrete platform send before any later chunk can fail. */
  onDeliveryResult?: (result: DiscordSendResult) => Promise<void> | void;
};

type DiscordClientRequest = ReturnType<typeof createDiscordClient>["request"];

const DEFAULT_DISCORD_MEDIA_MAX_MB = 100;

const DISCORD_FORMAT_PROFILE = {
  mechanism: "markdown",
  constructs: {
    bold: "native",
    italic: "native",
    underline: "native",
    strikethrough: "native",
    spoiler: "native",
    codeInline: "native",
    codeBlock: "native",
    codeLanguage: "native",
    linkLabel: "native",
    heading: "native",
    bulletList: "native",
    orderedList: "native",
    taskList: "native",
    table: "fallback",
    blockquote: "native",
    image: "native",
    mention: "native",
  },
  chunk: { limit: 2_000, unit: "utf16" },
} satisfies FormatCapabilityProfile;

const DISCORD_BOLD_PROBE_TEXT = "openclaw-discord-bold";
const DISCORD_BOLD_PROBE = renderMarkdownWithMarkers(
  {
    text: DISCORD_BOLD_PROBE_TEXT,
    styles: [{ start: 0, end: DISCORD_BOLD_PROBE_TEXT.length, style: "bold" }],
    links: [],
  },
  {
    styleMarkers: { bold: { open: "**", close: "**" } },
    escapeText: (value) => value,
  },
  DISCORD_FORMAT_PROFILE,
);
const DISCORD_BOLD_MARKERS = {
  open: DISCORD_BOLD_PROBE.slice(0, DISCORD_BOLD_PROBE.indexOf(DISCORD_BOLD_PROBE_TEXT)),
  close: DISCORD_BOLD_PROBE.slice(
    DISCORD_BOLD_PROBE.indexOf(DISCORD_BOLD_PROBE_TEXT) + DISCORD_BOLD_PROBE_TEXT.length,
  ),
};

type PositionedMarkdownNode = {
  type: string;
  children?: PositionedMarkdownNode[];
  position?: { start: { offset?: number }; end: { offset?: number } };
  [key: string]: unknown;
};

const DISCORD_NATIVE_TOKEN_RE = /<a?:[A-Za-z0-9_]+:\d+>|<\/[^>]+:\d+>/giu;
const DISCORD_URL_START_RE = /(?:[A-Za-z][A-Za-z0-9+.-]*:\/\/|www\.)/giu;

function findDiscordUrlRanges(markdown: string): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  for (const match of markdown.matchAll(DISCORD_URL_START_RE)) {
    const start = match.index;
    if (start === undefined) {
      continue;
    }
    const preceding = markdown[start - 1] ?? "";
    if (/[\p{L}\p{N}]/u.test(preceding) || (preceding === "_" && markdown[start - 2] !== "_")) {
      continue;
    }
    let end = start + match[0].length;
    let parenthesisDepth = 0;
    while (end < markdown.length) {
      const char = markdown[end];
      if (!char || /[\s<>]/u.test(char)) {
        break;
      }
      if (char === "(") {
        parenthesisDepth += 1;
      } else if (char === ")") {
        if (parenthesisDepth === 0) {
          break;
        }
        parenthesisDepth -= 1;
      }
      end += 1;
    }
    ranges.push({ start, end });
  }
  return ranges;
}

function markdownSemanticSignature(root: PositionedMarkdownNode): string {
  const parts: string[] = [];
  const pending: Array<{ node: PositionedMarkdownNode; parentStrong: boolean; exiting?: true }> = [
    { node: root, parentStrong: false },
  ];
  while (pending.length > 0) {
    const event = pending.pop();
    if (!event) {
      continue;
    }
    if (event.exiting) {
      parts.push(")");
      continue;
    }
    const { node } = event;
    const redundantStrong = event.parentStrong && node.type === "strong";
    const fields = Object.fromEntries(
      Object.entries(node).filter(([key]) => key !== "children" && key !== "position"),
    );
    const children = node.children ?? [];
    if (!redundantStrong) {
      parts.push(`(${JSON.stringify(fields)}`);
      pending.push({ node, parentStrong: event.parentStrong, exiting: true });
    }
    const parentStrong = event.parentStrong || node.type === "strong";
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        pending.push({ node: child, parentStrong });
      }
    }
  }
  return parts.join("\n");
}

function normalizeDiscordBold(markdown: string): string {
  // This outbound contract is CommonMark: `__x__` is bold, never Discord-native underline.
  const spans: Array<{ start: number; end: number }> = [];
  const contentEdits: Array<{
    spanId: number;
    start: number;
    marker: string;
    consume: number;
    delimiter: false;
  }> = [];
  const starEmphasisDelimiters = new Set<number>();
  const astLinkRanges: Array<{ start: number; end: number }> = [];
  const sourceTree = fromMarkdown(markdown) as PositionedMarkdownNode;
  const activeSpanIds: number[] = [];
  const pending: Array<{ node: PositionedMarkdownNode; exiting?: number }> = [{ node: sourceTree }];
  while (pending.length > 0) {
    const event = pending.pop();
    if (!event) {
      continue;
    }
    if (event.exiting !== undefined) {
      activeSpanIds.pop();
      continue;
    }
    const { node } = event;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (
      node.type === "link" &&
      start !== undefined &&
      end !== undefined &&
      markdown[start] === "<" &&
      markdown[end - 1] === ">"
    ) {
      astLinkRanges.push({ start, end });
    }
    let enteredSpanId: number | undefined;
    if (
      node.type === "strong" &&
      start !== undefined &&
      end !== undefined &&
      markdown.startsWith("__", start) &&
      markdown.slice(end - 2, end) === "__"
    ) {
      enteredSpanId = spans.length;
      spans.push({ start, end });
      activeSpanIds.push(enteredSpanId);
    }
    const spanId = activeSpanIds.at(-1);
    if (spanId !== undefined && start !== undefined && end !== undefined) {
      if (
        node.type === "strong" &&
        enteredSpanId === undefined &&
        markdown.startsWith("**", start) &&
        markdown.slice(end - 2, end) === "**"
      ) {
        contentEdits.push(
          { spanId, start, marker: "****", consume: 2, delimiter: false },
          { spanId, start: end - 2, marker: "****", consume: 2, delimiter: false },
        );
      } else if (node.type === "emphasis" && markdown[start] === "*" && markdown[end - 1] === "*") {
        starEmphasisDelimiters.add(start);
        starEmphasisDelimiters.add(end - 1);
        const intraword =
          /[\p{L}\p{N}]/u.test(markdown[start - 1] ?? "") ||
          /[\p{L}\p{N}]/u.test(markdown[end] ?? "");
        if (!intraword) {
          contentEdits.push(
            { spanId, start, marker: "_", consume: 1, delimiter: false },
            { spanId, start: end - 1, marker: "_", consume: 1, delimiter: false },
          );
        }
      } else if (node.type === "text") {
        for (let offset = start; offset < end; offset += 1) {
          if (markdown[offset] !== "*") {
            continue;
          }
          let precedingSlashes = 0;
          for (let index = offset - 1; index >= start && markdown[index] === "\\"; index -= 1) {
            precedingSlashes += 1;
          }
          if (precedingSlashes % 2 === 0) {
            contentEdits.push({
              spanId,
              start: offset,
              marker: "\\",
              consume: 0,
              delimiter: false,
            });
          }
        }
      }
    }
    if (enteredSpanId !== undefined) {
      pending.push({ node, exiting: enteredSpanId });
    }
    const children = node.children ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) {
        pending.push({ node: child });
      }
    }
  }
  if (spans.length === 0) {
    return markdown;
  }
  const strongInteriorStartByEnd = new Map<number, number>();
  for (const span of spans) {
    const interiorStart = span.start + 2;
    strongInteriorStartByEnd.set(
      span.end,
      Math.min(strongInteriorStartByEnd.get(span.end) ?? interiorStart, interiorStart),
    );
  }
  const nativeTokenRanges = [...markdown.matchAll(DISCORD_NATIVE_TOKEN_RE)].flatMap((match) =>
    match.index === undefined ? [] : [{ start: match.index, end: match.index + match[0].length }],
  );
  const protectedRanges = [
    ...findDiscordUrlRanges(markdown),
    ...astLinkRanges,
    ...nativeTokenRanges,
  ]
    .toSorted((left, right) => left.start - right.start)
    .map(({ start, end: rawEnd }) => {
      let end = rawEnd;
      while (/[.,!?;:'"]/u.test(markdown[end - 1] ?? "")) {
        end -= 1;
      }
      let previousEnd = -1;
      while (end !== previousEnd) {
        previousEnd = end;
        while (starEmphasisDelimiters.has(end - 1)) {
          end -= 1;
        }
        let strongInteriorStart = strongInteriorStartByEnd.get(end);
        while (strongInteriorStart !== undefined && start >= strongInteriorStart) {
          end -= 2;
          strongInteriorStart = strongInteriorStartByEnd.get(end);
        }
      }
      return { start, end };
    });
  const edits = [
    ...spans.flatMap((span, spanId) => [
      { spanId, start: span.start, marker: DISCORD_BOLD_MARKERS.open, consume: 2, delimiter: true },
      {
        spanId,
        start: span.end - 2,
        marker: DISCORD_BOLD_MARKERS.close,
        consume: 2,
        delimiter: true,
      },
    ]),
    ...contentEdits,
  ].toSorted((left, right) => left.start - right.start);
  const editsBySpan = new Map<number, Array<(typeof edits)[number]>>();
  for (const edit of edits) {
    const spanEdits = editsBySpan.get(edit.spanId);
    if (spanEdits) {
      spanEdits.push(edit);
    } else {
      editsBySpan.set(edit.spanId, [edit]);
    }
  }
  const protectedSpanIds = new Set<number>();
  const protectedEditKeys = new Set<string>();
  const spansWithProtectedContent = new Set<number>();
  let rangeIndex = 0;
  for (const edit of edits) {
    while ((protectedRanges[rangeIndex]?.end ?? Number.POSITIVE_INFINITY) <= edit.start) {
      rangeIndex += 1;
    }
    const range = protectedRanges[rangeIndex];
    const overlapsRange =
      range &&
      (edit.consume === 0
        ? edit.start >= range.start && edit.start < range.end
        : edit.start < range.end && edit.start + edit.consume > range.start);
    if (overlapsRange) {
      if (edit.delimiter) {
        protectedSpanIds.add(edit.spanId);
      } else {
        protectedEditKeys.add(`${edit.start}:${edit.consume}:${edit.marker}`);
        spansWithProtectedContent.add(edit.spanId);
      }
    }
  }
  for (const spanId of spansWithProtectedContent) {
    const span = spans[spanId];
    if (!span) {
      continue;
    }
    let localCursor = span.start;
    const localRendered =
      (editsBySpan.get(spanId) ?? [])
        .filter((edit) => {
          const key = `${edit.start}:${edit.consume}:${edit.marker}`;
          return !protectedEditKeys.has(key);
        })
        .map((edit) => {
          const chunk = `${markdown.slice(localCursor, edit.start)}${edit.marker}`;
          localCursor = edit.start + edit.consume;
          return chunk;
        })
        .join("") + markdown.slice(localCursor, span.end);
    const localSource = markdown.slice(span.start, span.end);
    if (
      markdownSemanticSignature(fromMarkdown(localRendered) as PositionedMarkdownNode) !==
      markdownSemanticSignature(fromMarkdown(localSource) as PositionedMarkdownNode)
    ) {
      protectedSpanIds.add(spanId);
    }
  }
  let cursor = 0;
  const seenEdits = new Set<string>();
  const rendered =
    edits
      .filter((edit) => {
        const key = `${edit.start}:${edit.consume}:${edit.marker}`;
        if (protectedSpanIds.has(edit.spanId) || protectedEditKeys.has(key) || seenEdits.has(key)) {
          return false;
        }
        seenEdits.add(key);
        return true;
      })
      .map((edit) => {
        const chunk = `${markdown.slice(cursor, edit.start)}${edit.marker}`;
        cursor = edit.start + edit.consume;
        return chunk;
      })
      .join("") + markdown.slice(cursor);
  return markdownSemanticSignature(fromMarkdown(rendered) as PositionedMarkdownNode) ===
    markdownSemanticSignature(sourceTree)
    ? rendered
    : markdown;
}

function renderDiscordMarkdown(markdown: string, tableMode: MarkdownTableMode): string {
  return normalizeDiscordBold(convertMarkdownTables(markdown, tableMode));
}

type DiscordChannelMessageResult = DiscordReceiptResultSource;

async function sendDiscordThreadTextChunks(params: {
  rest: RequestClient;
  threadId: string;
  chunks: readonly string[];
  request: DiscordClientRequest;
  maxLinesPerMessage?: number;
  chunkMode: ReturnType<typeof resolveChunkMode>;
  maxChars?: number;
  silent?: boolean;
  suppressEmbeds?: boolean;
  allowedMentions?: DiscordAllowedMentions;
  onResult?: DiscordSendProgress;
}): Promise<void> {
  for (const chunk of params.chunks) {
    await sendDiscordText({
      rest: params.rest,
      channelId: params.threadId,
      text: chunk,
      request: params.request,
      maxLinesPerMessage: params.maxLinesPerMessage,
      chunkMode: params.chunkMode,
      silent: params.silent,
      suppressEmbeds: params.suppressEmbeds,
      allowedMentions: params.allowedMentions,
      maxChars: params.maxChars,
      onResult: params.onResult,
    });
  }
}

function resolveDiscordSuppressEmbeds(params: {
  configured?: boolean;
  override?: boolean;
}): boolean {
  return params.override ?? params.configured ?? true;
}

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

function toDiscordSendResult(
  result: DiscordChannelMessageResult,
  fallbackChannelId: string,
  params: {
    kind?: Parameters<typeof createDiscordSendResult>[0]["kind"];
    threadId?: string | number;
    reply?: DiscordReplyReference;
  } = {},
): DiscordSendResult {
  const resultParams: Parameters<typeof createDiscordSendResult>[0] = {
    result,
    fallbackChannelId,
    kind: params.kind ?? "text",
  };
  if (params.threadId != null) {
    resultParams.threadId = params.threadId;
  }
  if (params.reply) {
    resultParams.reply = params.reply;
  }
  return createDiscordSendResult(resultParams);
}

async function resolveDiscordSendTarget(
  to: string,
  opts: DiscordSendOpts,
): Promise<{ rest: RequestClient; request: DiscordClientRequest; channelId: string }> {
  const cfg = requireRuntimeConfig(opts.cfg, "Discord send target resolution");
  const { rest, request } = createDiscordClient({ ...opts, cfg });
  const recipient = await parseAndResolveChannelRecipient(to, cfg, opts.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);
  return { rest, request, channelId };
}

export async function sendMessageDiscord(
  to: string,
  text: string,
  opts: DiscordSendOpts,
): Promise<DiscordSendResult> {
  const cfg = requireRuntimeConfig(opts.cfg, "Discord send");
  const accountInfo = resolveDiscordAccount({
    cfg,
    accountId: opts.accountId,
  });
  const tableMode = resolveMarkdownTableMode({
    cfg,
    channel: "discord",
    accountId: accountInfo.accountId,
  });
  const effectiveTableMode = opts.tableMode ?? tableMode;
  const chunkMode = opts.chunkMode ?? resolveChunkMode(cfg, "discord", accountInfo.accountId);
  const maxLinesPerMessage = opts.maxLinesPerMessage ?? accountInfo.config.maxLinesPerMessage;
  const suppressEmbeds = resolveDiscordSuppressEmbeds({
    configured: accountInfo.config.suppressEmbeds,
    override: opts.suppressEmbeds,
  });
  const textLimit =
    typeof opts.textLimit === "number" && Number.isFinite(opts.textLimit)
      ? Math.max(1, Math.min(Math.floor(opts.textLimit), 2000))
      : undefined;
  const mediaMaxBytes =
    typeof accountInfo.config.mediaMaxMb === "number"
      ? accountInfo.config.mediaMaxMb * 1024 * 1024
      : DEFAULT_DISCORD_MEDIA_MAX_MB * 1024 * 1024;
  const renderedText = renderDiscordMarkdown(text ?? "", effectiveTableMode);
  const textWithMentions = rewriteDiscordKnownMentions(renderedText, {
    accountId: accountInfo.accountId,
    mentionAliases: accountInfo.config.mentionAliases,
  });
  const { token, rest, request } = createDiscordClient({ ...opts, cfg });
  const recipient = await parseAndResolveChannelRecipient(to, cfg, opts.accountId);
  const { channelId } = await resolveChannelId(rest, recipient, request);

  // Forum/Media channels reject POST /messages; auto-create a thread post instead.
  const channel = await resolveDiscordChannel(rest, channelId);

  if (isForumLikeChannel(channel)) {
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
    let threadRes: { id: string; message?: { id: string; channel_id: string } };
    try {
      threadRes = (await request(
        () =>
          createThread<{ id: string; message?: { id: string; channel_id: string } }>(
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
          ),
        "forum-thread",
        { safety: "non-idempotent-create" },
      )) as { id: string; message?: { id: string; channel_id: string } };
    } catch (err) {
      throw await buildDiscordSendError(err, {
        channelId,
        cfg,
        rest,
        token,
        hasMedia: Boolean(opts.mediaUrl),
      });
    }

    const threadId = threadRes.id;
    const messageId = threadRes.message?.id ?? threadId;
    const resultChannelId = threadRes.message?.channel_id ?? threadId;
    const remainingChunks = chunks.slice(1);
    await opts.onDeliveryResult?.(
      toDiscordSendResult(
        {
          id: messageId,
          channel_id: resultChannelId,
        },
        channelId,
        { kind: "text", threadId },
      ),
    );
    const reportThreadResult: DiscordSendProgress = async (result, kind) => {
      await opts.onDeliveryResult?.(toDiscordSendResult(result, threadId, { kind, threadId }));
    };

    try {
      if (opts.mediaUrl) {
        const [mediaCaption, ...afterMediaChunks] = remainingChunks;
        await sendDiscordMedia({
          rest,
          channelId: threadId,
          text: mediaCaption ?? "",
          mediaUrl: opts.mediaUrl,
          filename: opts.filename,
          mediaAccess: opts.mediaAccess,
          mediaLocalRoots: opts.mediaLocalRoots,
          mediaReadFile: opts.mediaReadFile,
          maxBytes: mediaMaxBytes,
          request,
          maxLinesPerMessage,
          chunkMode,
          silent: opts.silent,
          suppressEmbeds,
          allowedMentions: opts.allowedMentions,
          maxChars: textLimit,
          onResult: reportThreadResult,
        });
        await sendDiscordThreadTextChunks({
          rest,
          threadId,
          chunks: afterMediaChunks,
          request,
          maxLinesPerMessage,
          chunkMode,
          maxChars: textLimit,
          silent: opts.silent,
          suppressEmbeds,
          allowedMentions: opts.allowedMentions,
          onResult: reportThreadResult,
        });
      } else {
        await sendDiscordThreadTextChunks({
          rest,
          threadId,
          chunks: remainingChunks,
          request,
          maxLinesPerMessage,
          chunkMode,
          maxChars: textLimit,
          silent: opts.silent,
          suppressEmbeds,
          allowedMentions: opts.allowedMentions,
          onResult: reportThreadResult,
        });
      }
    } catch (err) {
      throw await buildDiscordSendError(err, {
        channelId: threadId,
        cfg,
        rest,
        token,
        hasMedia: Boolean(opts.mediaUrl),
      });
    }

    recordChannelActivity({
      channel: "discord",
      accountId: accountInfo.accountId,
      direction: "outbound",
    });
    return toDiscordSendResult(
      {
        id: messageId,
        channel_id: resultChannelId,
      },
      channelId,
      { kind: opts.mediaUrl ? "media" : "text", threadId },
    );
  }

  let result: DiscordChannelMessageResult;
  const reportResult: DiscordSendProgress = async (progressResult, kind, replyToId) => {
    await opts.onDeliveryResult?.(
      toDiscordSendResult(progressResult, channelId, {
        kind,
        reply: createReusableDiscordReplyReference(replyToId),
      }),
    );
  };
  try {
    if (opts.mediaUrl) {
      result = await sendDiscordMedia({
        rest,
        channelId,
        text: textWithMentions,
        mediaUrl: opts.mediaUrl,
        filename: opts.filename,
        mediaAccess: opts.mediaAccess,
        mediaLocalRoots: opts.mediaLocalRoots,
        mediaReadFile: opts.mediaReadFile,
        maxBytes: mediaMaxBytes,
        reply: opts.reply,
        request,
        maxLinesPerMessage,
        components: opts.components,
        embeds: opts.embeds,
        chunkMode,
        silent: opts.silent,
        suppressEmbeds,
        allowedMentions: opts.allowedMentions,
        maxChars: textLimit,
        onResult: reportResult,
      });
    } else {
      result = await sendDiscordText({
        rest,
        channelId,
        text: textWithMentions,
        reply: opts.reply,
        request,
        maxLinesPerMessage,
        components: opts.components,
        embeds: opts.embeds,
        chunkMode,
        silent: opts.silent,
        suppressEmbeds,
        allowedMentions: opts.allowedMentions,
        maxChars: textLimit,
        onResult: reportResult,
      });
    }
  } catch (err) {
    throw await buildDiscordSendError(err, {
      channelId,
      cfg,
      rest,
      token,
      hasMedia: Boolean(opts.mediaUrl),
    });
  }

  recordChannelActivity({
    channel: "discord",
    accountId: accountInfo.accountId,
    direction: "outbound",
  });
  return toDiscordSendResult(result, channelId, {
    kind: opts.mediaUrl ? "media" : opts.components || opts.embeds ? "card" : "text",
    reply: opts.reply,
  });
}

export async function sendStickerDiscord(
  to: string,
  stickerIds: string[],
  opts: DiscordSendOpts & { content?: string },
): Promise<DiscordSendResult> {
  const { rest, request, channelId, rewrittenContent, suppressEmbeds } =
    await resolveDiscordStructuredSendContext(to, opts);
  const stickers = normalizeStickerIds(stickerIds);
  const flags = resolveDiscordMessageFlags({ suppressEmbeds });
  const body = {
    content: rewrittenContent || undefined,
    sticker_ids: stickers,
    nonce: createDiscordMessageNonce(),
    enforce_nonce: true,
    ...(flags ? { flags } : {}),
  };
  const res = (await request(
    () => createChannelMessage<{ id: string; channel_id: string }>(rest, channelId, { body }),
    "sticker",
    { safety: "nonce-protected-create" },
  )) as { id: string; channel_id: string };
  return toDiscordSendResult(res, channelId, { kind: "card" });
}

export async function sendPollDiscord(
  to: string,
  poll: PollInput,
  opts: DiscordSendOpts & { content?: string },
): Promise<DiscordSendResult> {
  const { rest, request, channelId, rewrittenContent, suppressEmbeds } =
    await resolveDiscordStructuredSendContext(to, opts);
  if (poll.durationSeconds !== undefined) {
    throw new Error("Discord polls do not support durationSeconds; use durationHours");
  }
  const payload = normalizeDiscordPollInput(poll);
  const flags = resolveDiscordMessageFlags({ silent: opts.silent, suppressEmbeds });
  const body = {
    content: rewrittenContent || undefined,
    poll: payload,
    nonce: createDiscordMessageNonce(),
    enforce_nonce: true,
    ...(flags ? { flags } : {}),
  };
  const res = (await request(
    () => createChannelMessage<{ id: string; channel_id: string }>(rest, channelId, { body }),
    "poll",
    { safety: "nonce-protected-create" },
  )) as { id: string; channel_id: string };
  return toDiscordSendResult(res, channelId, { kind: "card" });
}

async function resolveDiscordStructuredSendContext(
  to: string,
  opts: DiscordSendOpts & { content?: string },
): Promise<{
  rest: RequestClient;
  request: DiscordClientRequest;
  channelId: string;
  rewrittenContent?: string;
  suppressEmbeds: boolean;
}> {
  const cfg = requireRuntimeConfig(opts.cfg, "Discord structured send");
  const accountInfo = resolveDiscordAccount({
    cfg,
    accountId: opts.accountId,
  });
  const { rest, request, channelId } = await resolveDiscordSendTarget(to, opts);
  const content = opts.content?.trim();
  const rewrittenContent = content
    ? rewriteDiscordKnownMentions(content, {
        accountId: accountInfo.accountId,
        mentionAliases: accountInfo.config.mentionAliases,
      })
    : undefined;
  return {
    rest,
    request,
    channelId,
    rewrittenContent,
    suppressEmbeds: resolveDiscordSuppressEmbeds({
      configured: accountInfo.config.suppressEmbeds,
      override: opts.suppressEmbeds,
    }),
  };
}
