import type { MatrixClient } from "@vector-im/matrix-bot-sdk";
import type { PollInput } from "openclaw/plugin-sdk/matrix";
import { getMatrixRuntime } from "../runtime.js";
import { buildPollStartContent, M_POLL_START } from "./poll-types.js";
import { getMatrixLogService } from "./sdk-runtime.js";
import { enqueueSend } from "./send-queue.js";
import { resolveMatrixClient, resolveMediaMaxBytes } from "./send/client.js";
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
import {
  clearDirectRoomCacheForTarget,
  isMatrixUserTarget,
  normalizeThreadId,
  resolveMatrixRoomId,
} from "./send/targets.js";
import {
  EventType,
  MsgType,
  RelationType,
  type MatrixOutboundContent,
  type MatrixSendOpts,
  type MatrixSendResult,
  type ReactionEventContent,
} from "./send/types.js";

const MATRIX_TEXT_LIMIT = 4000;
const getCore = () => getMatrixRuntime();

function getMatrixErrorCode(err: unknown): string | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate = err as {
    errcode?: unknown;
    body?: {
      errcode?: unknown;
    };
  };
  if (typeof candidate.errcode === "string") {
    return candidate.errcode;
  }
  return typeof candidate.body?.errcode === "string" ? candidate.body.errcode : undefined;
}

function getMatrixStatusCode(err: unknown): number | undefined {
  if (!err || typeof err !== "object") {
    return undefined;
  }
  const candidate = err as {
    statusCode?: unknown;
  };
  return typeof candidate.statusCode === "number" ? candidate.statusCode : undefined;
}

function isRetryableDirectRoomSendError(err: unknown): boolean {
  const statusCode = getMatrixStatusCode(err);
  if (statusCode === 403 || statusCode === 404) {
    return true;
  }
  const errcode = getMatrixErrorCode(err);
  return errcode === "M_FORBIDDEN" || errcode === "M_NOT_FOUND";
}

type ResolvedRoomAttemptError = {
  cause: unknown;
  sentAnyContent: boolean;
};

function asResolvedRoomAttemptError(err: unknown): ResolvedRoomAttemptError | null {
  if (!err || typeof err !== "object") {
    return null;
  }
  const candidate = err as {
    cause?: unknown;
    sentAnyContent?: unknown;
  };
  if (typeof candidate.sentAnyContent !== "boolean") {
    return null;
  }
  return {
    cause: candidate.cause,
    sentAnyContent: candidate.sentAnyContent,
  };
}

async function withResolvedRoomRetry<T>(params: {
  client: MatrixClient;
  to: string;
  action: (roomId: string, markContentSent: () => void) => Promise<T>;
}): Promise<T> {
  const { client, to, action } = params;
  const runAction = async (roomId: string): Promise<T> => {
    let sentAnyContent = false;
    try {
      return await enqueueSend(
        roomId,
        async () =>
          await action(roomId, () => {
            sentAnyContent = true;
          }),
      );
    } catch (err) {
      throw {
        cause: err,
        sentAnyContent,
      } satisfies ResolvedRoomAttemptError;
    }
  };

  const roomId = await resolveMatrixRoomId(client, to);
  try {
    return await runAction(roomId);
  } catch (err) {
    const attemptError = asResolvedRoomAttemptError(err);
    const firstError = attemptError?.cause ?? err;
    if (
      !isMatrixUserTarget(to) ||
      attemptError?.sentAnyContent === true ||
      !isRetryableDirectRoomSendError(firstError)
    ) {
      throw firstError;
    }

    clearDirectRoomCacheForTarget(client, to);

    try {
      const refreshedRoomId = await resolveMatrixRoomId(client, to);
      return await runAction(refreshedRoomId);
    } catch (retryErr) {
      const retryAttemptError = asResolvedRoomAttemptError(retryErr);
      const resolvedRetryError = retryAttemptError?.cause ?? retryErr;
      if (retryAttemptError?.sentAnyContent !== true) {
        clearDirectRoomCacheForTarget(client, to);
      }
      const LogService = getMatrixLogService();
      LogService.warn(
        "MatrixSend",
        "Direct-room self-heal failed after send error; waiting for next external invocation",
        {
          target: to,
          firstError: String(firstError),
          retryError: String(resolvedRetryError),
        },
      );
      throw resolvedRetryError;
    }
  }
}

export type { MatrixSendOpts, MatrixSendResult } from "./send/types.js";
export { resolveMatrixRoomId } from "./send/targets.js";

export async function sendMessageMatrix(
  to: string,
  message: string,
  opts: MatrixSendOpts = {},
): Promise<MatrixSendResult> {
  const trimmedMessage = message?.trim() ?? "";
  if (!trimmedMessage && !opts.mediaUrl) {
    throw new Error("Matrix send requires text or media");
  }
  const { client, stopOnDone } = await resolveMatrixClient({
    client: opts.client,
    timeoutMs: opts.timeoutMs,
    accountId: opts.accountId,
    cfg: opts.cfg,
  });
  const cfg = opts.cfg ?? getCore().config.loadConfig();
  try {
    return await withResolvedRoomRetry({
      client,
      to,
      action: async (roomId, markContentSent) => {
        const tableMode = getCore().channel.text.resolveMarkdownTableMode({
          cfg,
          channel: "matrix",
          accountId: opts.accountId,
        });
        const convertedMessage = getCore().channel.text.convertMarkdownTables(
          trimmedMessage,
          tableMode,
        );
        const textLimit = getCore().channel.text.resolveTextChunkLimit(cfg, "matrix");
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
          markContentSent();
          return eventId;
        };

        let lastMessageId = "";
        if (opts.mediaUrl) {
          const maxBytes = resolveMediaMaxBytes(opts.accountId, cfg);
          const media = await getCore().media.loadWebMedia(opts.mediaUrl, maxBytes);
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
            ? await prepareImageInfo({ buffer: media.buffer, client })
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
    });
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
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
  const { client, stopOnDone } = await resolveMatrixClient({
    client: opts.client,
    timeoutMs: opts.timeoutMs,
    accountId: opts.accountId,
    cfg: opts.cfg,
  });

  try {
    return await withResolvedRoomRetry({
      client,
      to,
      action: async (roomId, markContentSent) => {
        const pollContent = buildPollStartContent(poll);
        const threadId = normalizeThreadId(opts.threadId);
        const pollPayload = threadId
          ? { ...pollContent, "m.relates_to": buildThreadRelation(threadId) }
          : pollContent;
        const eventId = await client.sendEvent(roomId, M_POLL_START, pollPayload);
        markContentSent();

        return {
          eventId: eventId ?? "unknown",
          roomId,
        };
      },
    });
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
}

export async function sendTypingMatrix(
  roomId: string,
  typing: boolean,
  timeoutMs?: number,
  client?: MatrixClient,
): Promise<void> {
  const { client: resolved, stopOnDone } = await resolveMatrixClient({
    client,
    timeoutMs,
  });
  try {
    const resolvedTimeoutMs = typeof timeoutMs === "number" ? timeoutMs : 30_000;
    await resolved.setTyping(roomId, typing, resolvedTimeoutMs);
  } finally {
    if (stopOnDone) {
      resolved.stop();
    }
  }
}

export async function sendReadReceiptMatrix(
  roomId: string,
  eventId: string,
  client?: MatrixClient,
): Promise<void> {
  if (!eventId?.trim()) {
    return;
  }
  const { client: resolved, stopOnDone } = await resolveMatrixClient({
    client,
  });
  try {
    const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
    await resolved.sendReadReceipt(resolvedRoom, eventId.trim());
  } finally {
    if (stopOnDone) {
      resolved.stop();
    }
  }
}

export async function reactMatrixMessage(
  roomId: string,
  messageId: string,
  emoji: string,
  client?: MatrixClient,
): Promise<void> {
  if (!emoji.trim()) {
    throw new Error("Matrix reaction requires an emoji");
  }
  const { client: resolved, stopOnDone } = await resolveMatrixClient({
    client,
  });
  try {
    const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
    const reaction: ReactionEventContent = {
      "m.relates_to": {
        rel_type: RelationType.Annotation,
        event_id: messageId,
        key: emoji,
      },
    };
    await resolved.sendEvent(resolvedRoom, EventType.Reaction, reaction);
  } finally {
    if (stopOnDone) {
      resolved.stop();
    }
  }
}
