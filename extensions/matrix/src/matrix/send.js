import { getMatrixRuntime } from "../runtime.js";
import { buildPollStartContent, M_POLL_START } from "./poll-types.js";
import { enqueueSend } from "./send-queue.js";
import { resolveMatrixClient, resolveMediaMaxBytes } from "./send/client.js";
import {
  buildReplyRelation,
  buildTextContent,
  buildThreadRelation,
  resolveMatrixMsgType,
  resolveMatrixVoiceDecision
} from "./send/formatting.js";
import {
  buildMediaContent,
  prepareImageInfo,
  resolveMediaDurationMs,
  uploadMediaMaybeEncrypted
} from "./send/media.js";
import { normalizeThreadId, resolveMatrixRoomId } from "./send/targets.js";
import {
  EventType,
  MsgType,
  RelationType
} from "./send/types.js";
const MATRIX_TEXT_LIMIT = 4e3;
const getCore = () => getMatrixRuntime();
import { resolveMatrixRoomId as resolveMatrixRoomId2 } from "./send/targets.js";
async function sendMessageMatrix(to, message, opts = {}) {
  const trimmedMessage = message?.trim() ?? "";
  if (!trimmedMessage && !opts.mediaUrl) {
    throw new Error("Matrix send requires text or media");
  }
  const { client, stopOnDone } = await resolveMatrixClient({
    client: opts.client,
    timeoutMs: opts.timeoutMs,
    accountId: opts.accountId,
    cfg: opts.cfg
  });
  const cfg = opts.cfg ?? getCore().config.loadConfig();
  try {
    const roomId = await resolveMatrixRoomId(client, to);
    return await enqueueSend(roomId, async () => {
      const tableMode = getCore().channel.text.resolveMarkdownTableMode({
        cfg,
        channel: "matrix",
        accountId: opts.accountId
      });
      const convertedMessage = getCore().channel.text.convertMarkdownTables(
        trimmedMessage,
        tableMode
      );
      const textLimit = getCore().channel.text.resolveTextChunkLimit(cfg, "matrix");
      const chunkLimit = Math.min(textLimit, MATRIX_TEXT_LIMIT);
      const chunkMode = getCore().channel.text.resolveChunkMode(cfg, "matrix", opts.accountId);
      const chunks = getCore().channel.text.chunkMarkdownTextWithMode(
        convertedMessage,
        chunkLimit,
        chunkMode
      );
      const threadId = normalizeThreadId(opts.threadId);
      const relation = threadId ? buildThreadRelation(threadId, opts.replyToId) : buildReplyRelation(opts.replyToId);
      const sendContent = async (content) => {
        const eventId = await client.sendMessage(roomId, content);
        return eventId;
      };
      let lastMessageId = "";
      if (opts.mediaUrl) {
        const maxBytes = resolveMediaMaxBytes(opts.accountId, cfg);
        const media = await getCore().media.loadWebMedia(opts.mediaUrl, maxBytes);
        const uploaded = await uploadMediaMaybeEncrypted(client, roomId, media.buffer, {
          contentType: media.contentType,
          filename: media.fileName
        });
        const durationMs = await resolveMediaDurationMs({
          buffer: media.buffer,
          contentType: media.contentType,
          fileName: media.fileName,
          kind: media.kind ?? "unknown"
        });
        const baseMsgType = resolveMatrixMsgType(media.contentType, media.fileName);
        const { useVoice } = resolveMatrixVoiceDecision({
          wantsVoice: opts.audioAsVoice === true,
          contentType: media.contentType,
          fileName: media.fileName
        });
        const msgtype = useVoice ? MsgType.Audio : baseMsgType;
        const isImage = msgtype === MsgType.Image;
        const imageInfo = isImage ? await prepareImageInfo({ buffer: media.buffer, client }) : void 0;
        const [firstChunk, ...rest] = chunks;
        const body = useVoice ? "Voice message" : firstChunk ?? media.fileName ?? "(file)";
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
          imageInfo
        });
        const eventId = await sendContent(content);
        lastMessageId = eventId ?? lastMessageId;
        const textChunks = useVoice ? chunks : rest;
        const followupRelation = threadId ? relation : void 0;
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
        roomId
      };
    });
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
}
async function sendPollMatrix(to, poll, opts = {}) {
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
    cfg: opts.cfg
  });
  try {
    const roomId = await resolveMatrixRoomId(client, to);
    const pollContent = buildPollStartContent(poll);
    const threadId = normalizeThreadId(opts.threadId);
    const pollPayload = threadId ? { ...pollContent, "m.relates_to": buildThreadRelation(threadId) } : pollContent;
    const eventId = await client.sendEvent(roomId, M_POLL_START, pollPayload);
    return {
      eventId: eventId ?? "unknown",
      roomId
    };
  } finally {
    if (stopOnDone) {
      client.stop();
    }
  }
}
async function sendTypingMatrix(roomId, typing, timeoutMs, client) {
  const { client: resolved, stopOnDone } = await resolveMatrixClient({
    client,
    timeoutMs
  });
  try {
    const resolvedTimeoutMs = typeof timeoutMs === "number" ? timeoutMs : 3e4;
    await resolved.setTyping(roomId, typing, resolvedTimeoutMs);
  } finally {
    if (stopOnDone) {
      resolved.stop();
    }
  }
}
async function sendReadReceiptMatrix(roomId, eventId, client) {
  if (!eventId?.trim()) {
    return;
  }
  const { client: resolved, stopOnDone } = await resolveMatrixClient({
    client
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
async function reactMatrixMessage(roomId, messageId, emoji, client) {
  if (!emoji.trim()) {
    throw new Error("Matrix reaction requires an emoji");
  }
  const { client: resolved, stopOnDone } = await resolveMatrixClient({
    client
  });
  try {
    const resolvedRoom = await resolveMatrixRoomId(resolved, roomId);
    const reaction = {
      "m.relates_to": {
        rel_type: RelationType.Annotation,
        event_id: messageId,
        key: emoji
      }
    };
    await resolved.sendEvent(resolvedRoom, EventType.Reaction, reaction);
  } finally {
    if (stopOnDone) {
      resolved.stop();
    }
  }
}
export {
  reactMatrixMessage,
  resolveMatrixRoomId2 as resolveMatrixRoomId,
  sendMessageMatrix,
  sendPollMatrix,
  sendReadReceiptMatrix,
  sendTypingMatrix
};
