import type { PollInput } from "../runtime-api.js";
import { getMatrixRuntime } from "../runtime.js";
import type { CoreConfig } from "../types.js";
import { buildPollStartContent, M_POLL_START } from "./poll-types.js";
import { buildMatrixReactionContent } from "./reaction-common.js";
import type { MatrixClient } from "./sdk.js";
import { resolveMediaMaxBytes, withResolvedMatrixClient } from "./send/client.js";
import {
  buildReplyRelation,
  buildTextContent,
  buildThreadRelation,
  resolveMatrixMsgType,
  resolveMatrixVoiceDecision,
} from "./send/formatting.js";
import {
  buildMediaContent,
  prepareImageInfo,
  resolveMediaDurationMs,
  uploadMediaMaybeEncrypted,
} from "./send/media.js";
import { normalizeThreadId, resolveMatrixRoomId } from "./send/targets.js";
import {
  EventType,
  MsgType,
  type MatrixOutboundContent,
  type MatrixSendOpts,
  type MatrixSendResult,
} from "./send/types.js";

const MATRIX_TEXT_LIMIT = 4000;
const getCore = () => getMatrixRuntime();

export type { MatrixSendOpts, MatrixSendResult } from "./send/types.js";
export { resolveMatrixRoomId } from "./send/targets.js";

type MatrixClientResolveOpts = {
  client?: MatrixClient;
  cfg?: CoreConfig;
  timeoutMs?: number;
  accountId?: string | null;
};

function isMatrixClient(value: MatrixClient | MatrixClientResolveOpts): value is MatrixClient {
  return typeof (value as { sendEvent?: unknown }).sendEvent === "function";
}

function normalizeMatrixClientResolveOpts(
  opts?: MatrixClient | MatrixClientResolveOpts,
): MatrixClientResolveOpts {
  if (!opts) {
    return {};
  }
  if (isMatrixClient(opts)) {
    return { client: opts };
  }
  return {
    client: opts.client,
    cfg: opts.cfg,
    timeoutMs: opts.timeoutMs,
    accountId: opts.accountId,
  };
}

export async function sendMessageMatrix(
  to: string,
  message: string | undefined,
  opts: MatrixSendOpts = {},
): Promise<MatrixSendResult> {
  const trimmedMessage = message?.trim() ?? "";
  if (!trimmedMessage && !opts.mediaUrl) {
    throw new Error("Matrix send requires text or media");
  }
  return await withResolvedMatrixClient(
    {
      client: opts.client,
      cfg: opts.cfg,
      timeoutMs: opts.timeoutMs,
      accountId: opts.accountId,
    },
    async (client) => {
      const roomId = await resolveMatrixRoomId(client, to);
      const cfg = opts.cfg ?? getCore().config.loadConfig();
      const tableMode = getCore().channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "matrix",
        accountId: opts.accountId,
      });
      const convertedMessage = getCore().channel.text.convertMarkdownTables(
        trimmedMessage,
        tableMode,
      );
      const textLimit = getCore().channel.text.resolveTextChunkLimit(cfg, "matrix", opts.accountId);
      const chunkLimit = Math.min(textLimit, MATRIX_TEXT_LIMIT);
      const chunkMode = getCore().channel.text.resolveChunkMode(cfg, "matrix", opts.accountId);
      const chunks = getCore().channel.text.chunkMarkdownTextWithMode(
        convertedMessage,
        chunkLimit,
        chunkMode,
      );
      const threadId = normalizeThreadId(opts.threadId);
      const relation = threadId
        ? buildThreadRelation(threadId, opts.replyToId)
        : buildReplyRelation(opts.replyToId);
      const sendContent = async (content: MatrixOutboundContent) => {
        const eventId = await client.sendMessage(roomId, content);
        return eventId;
      };

      let lastMessageId = "";
      if (opts.mediaUrl) {
        const maxBytes = resolveMediaMaxBytes(opts.accountId, cfg);
        const media = await getCore().media.loadWebMedia(opts.mediaUrl, {
          maxBytes,
          localRoots: opts.mediaLocalRoots,
        });
        const uploaded = await uploadMediaMaybeEncrypted(client, roomId, media.buffer, {
          contentType: media.contentType,
          filename: media.fileName,
        });
        const durationMs = await resolveMediaDurationMs({
          buffer: media.buffer,
          contentType: media.contentType,
          fileName: media.fileName,
          kind: media.kind ?? "unknown",
        });
        const baseMsgType = resolveMatrixMsgType(media.contentType, media.fileName);
        const { useVoice } = resolveMatrixVoiceDecision({
          wantsVoice: opts.audioAsVoice === true,
          contentType: media.contentType,
          fileName: media.fileName,
        });
        const msgtype = useVoice ? MsgType.Audio : baseMsgType;
        const isImage = msgtype === MsgType.Image;
        const imageInfo = isImage
          ? await prepareImageInfo({
              buffer: media.buffer,
              client,
              encrypted: Boolean(uploaded.file),
            })
          : undefined;
        const [firstChunk, ...rest] = chunks;
        const body = useVoice ? "Voice message" : (firstChunk ?? media.fileName ?? "(file)");
        const content = buildMediaContent({
          msgtype,
          body,
          url: uploaded.url,
          file: uploaded.file,
          filename: media.fileName,
          mimetype: media.contentType,
          size: media.buffer.byteLength,
          durationMs,
          relation,
          isVoice: useVoice,
          imageInfo,
        });
        const eventId = await sendContent(content);
        lastMessageId = eventId ?? lastMessageId;
        const textChunks = useVoice ? chunks : rest;
        const followupRelation = threadId ? relation : undefined;
        for (const chunk of textChunks) {
          const text = chunk.trim();
          if (!text) {
            continue;
          }
          const followup = buildTextContent(text, followupRelation);
          const followupEventId = await sendContent(followup);
          lastMessageId = followupEventId ?? lastMessageId;
        }
      } else {
        for (const chunk of chunks.length ? chunks : [""]) {
          const text = chunk.trim();
          if (!text) {
            continue;
          }
          const content = buildTextContent(text, relation);
          const eventId = await sendContent(content);
          lastMessageId = eventId ?? lastMessageId;
        }
      }

      return {
        messageId: lastMessageId || "unknown",
        roomId,
      };
    },
  );
}

export async function sendPollMatrix(
  to: string,
  poll: PollInput,
  opts: MatrixSendOpts = {},
): Promise<{ eventId: string; roomId: string }> {
  if (!poll.question?.trim()) {
    throw new Error("Matrix poll requires a question");
  }
  if (!poll.options?.length) {
    throw new Error("Matrix poll requires options");
  }
  return await withResolvedMatrixClient(
    {
      client: opts.client,
      cfg: opts.cfg,
      timeoutMs: opts.timeoutMs,
      accountId: opts.accountId,
    },
    async (client) => {
      const roomId = await resolveMatrixRoomId(client, to);
      const pollContent = buildPollStartContent(poll);
      const threadId = normalizeThreadId(opts.threadId);
      const pollPayload = threadId
        ? { ...pollContent, "m.relates_to": buildThreadRelation(threadId) }
        : pollContent;
      const eventId = await client.sendEvent(roomId, M_POLL_START, pollPayload);

      return {
        eventId: eventId ?? "unknown",
        roomId,
      };
    },
  );
}

export async function sendTypingMatrix(
  roomId: string,
  typing: boolean,
  timeoutMs?: number,
  client?: MatrixClient,
): Promise<void> {
  await withResolvedMatrixClient(
    {
      client,
      timeoutMs,
    },
    async (resolved) => {
      const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
      const resolvedTimeoutMs = typeof timeoutMs === "number" ? timeoutMs : 30_000;
      await resolved.setTyping(resolvedRoom, typing, resolvedTimeoutMs);
    },
  );
}

export async function sendReadReceiptMatrix(
  roomId: string,
  eventId: string,
  client?: MatrixClient,
): Promise<void> {
  if (!eventId?.trim()) {
    return;
  }
  await withResolvedMatrixClient({ client }, async (resolved) => {
    const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
    await resolved.sendReadReceipt(resolvedRoom, eventId.trim());
  });
}

export async function reactMatrixMessage(
  roomId: string,
  messageId: string,
  emoji: string,
  opts?: MatrixClient | MatrixClientResolveOpts,
): Promise<void> {
  const clientOpts = normalizeMatrixClientResolveOpts(opts);
  await withResolvedMatrixClient(
    {
      client: clientOpts.client,
      cfg: clientOpts.cfg,
      timeoutMs: clientOpts.timeoutMs,
      accountId: clientOpts.accountId ?? undefined,
    },
    async (resolved) => {
      const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
      const reaction = buildMatrixReactionContent(messageId, emoji);
      await resolved.sendEvent(resolvedRoom, EventType.Reaction, reaction);
    },
  );
}
