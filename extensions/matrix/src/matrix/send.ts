import type {
  DimensionalFileInfo,
  EncryptedFile,
  FileWithThumbnailInfo,
  MessageEventContent,
  TextualMessageEventContent,
  TimedFileInfo,
  VideoFileInfo,
  MatrixClient,
} from "matrix-bot-sdk";
import { parseBuffer, type IFileInfo } from "music-metadata";

import type { PollInput } from "clawdbot/plugin-sdk";
import { getMatrixRuntime } from "../runtime.js";
import { getActiveMatrixClient } from "./active-client.js";
import {
  createMatrixClient,
  isBunRuntime,
  resolveMatrixAuth,
  resolveSharedMatrixClient,
} from "./client.js";
import { markdownToMatrixHtml } from "./format.js";
import { buildPollStartContent, M_POLL_START } from "./poll-types.js";
import type { CoreConfig } from "../types.js";

const MATRIX_TEXT_LIMIT = 4000;
const getCore = () => getMatrixRuntime();

// Message types
const MsgType = {
  Text: "m.text",
  Image: "m.image",
  Audio: "m.audio",
  Video: "m.video",
  File: "m.file",
  Notice: "m.notice",
} as const;

// Relation types
const RelationType = {
  Annotation: "m.annotation",
  Replace: "m.replace",
  Thread: "m.thread",
} as const;

// Event types
const EventType = {
  Direct: "m.direct",
  Reaction: "m.reaction",
  RoomMessage: "m.room.message",
} as const;

type MatrixDirectAccountData = Record<string, string[]>;

type MatrixReplyRelation = {
  "m.in_reply_to": { event_id: string };
};

type MatrixThreadRelation = {
  rel_type: typeof RelationType.Thread;
  event_id: string;
  is_falling_back?: boolean;
  "m.in_reply_to"?: { event_id: string };
};

type MatrixRelation = MatrixReplyRelation | MatrixThreadRelation;

type MatrixReplyMeta = {
  "m.relates_to"?: MatrixRelation;
};

type MatrixMediaInfo = FileWithThumbnailInfo | DimensionalFileInfo | TimedFileInfo | VideoFileInfo;

type MatrixTextContent = TextualMessageEventContent & MatrixReplyMeta;

type MatrixMediaContent = MessageEventContent &
  MatrixReplyMeta & {
    info?: MatrixMediaInfo;
    url?: string;
    file?: EncryptedFile;
    filename?: string;
    "org.matrix.msc3245.voice"?: Record<string, never>;
    "org.matrix.msc1767.audio"?: { duration: number };
  };

type MatrixOutboundContent = MatrixTextContent | MatrixMediaContent;

type ReactionEventContent = {
  "m.relates_to": {
    rel_type: typeof RelationType.Annotation;
    event_id: string;
    key: string;
  };
};

export type MatrixSendResult = {
  messageId: string;
  roomId: string;
};

export type MatrixSendOpts = {
  client?: MatrixClient;
  mediaUrl?: string;
  replyToId?: string;
  threadId?: string | number | null;
  timeoutMs?: number;
  /** Send audio as voice message (voice bubble) instead of audio file. Defaults to false. */
  audioAsVoice?: boolean;
};

function ensureNodeRuntime() {
  if (isBunRuntime()) {
    throw new Error("Matrix support requires Node (bun runtime not supported)");
  }
}

function resolveMediaMaxBytes(): number | undefined {
  const cfg = getCore().config.loadConfig() as CoreConfig;
  if (typeof cfg.channels?.matrix?.mediaMaxMb === "number") {
    return cfg.channels.matrix.mediaMaxMb * 1024 * 1024;
  }
  return undefined;
}

function normalizeTarget(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new Error("Matrix target is required (room:<id> or #alias)");
  }
  return trimmed;
}

function normalizeThreadId(raw?: string | number | null): string | null {
  if (raw === undefined || raw === null) return null;
  const trimmed = String(raw).trim();
  return trimmed ? trimmed : null;
}

async function resolveDirectRoomId(client: MatrixClient, userId: string): Promise<string> {
  const trimmed = userId.trim();
  if (!trimmed.startsWith("@")) {
    throw new Error(`Matrix user IDs must be fully qualified (got "${trimmed}")`);
  }
  // matrix-bot-sdk: use getAccountData to retrieve m.direct
  try {
    const directContent = await client.getAccountData(EventType.Direct) as MatrixDirectAccountData | null;
    const list = Array.isArray(directContent?.[trimmed]) ? directContent[trimmed] : [];
    if (list.length > 0) return list[0];
  } catch {
    // Ignore errors, try fetching from server
  }
  throw new Error(
    `No m.direct room found for ${trimmed}. Open a DM first so Matrix can set m.direct.`,
  );
}

export async function resolveMatrixRoomId(
  client: MatrixClient,
  raw: string,
): Promise<string> {
  const target = normalizeTarget(raw);
  const lowered = target.toLowerCase();
  if (lowered.startsWith("matrix:")) {
    return await resolveMatrixRoomId(client, target.slice("matrix:".length));
  }
  if (lowered.startsWith("room:")) {
    return await resolveMatrixRoomId(client, target.slice("room:".length));
  }
  if (lowered.startsWith("channel:")) {
    return await resolveMatrixRoomId(client, target.slice("channel:".length));
  }
  if (lowered.startsWith("user:")) {
    return await resolveDirectRoomId(client, target.slice("user:".length));
  }
  if (target.startsWith("@")) {
    return await resolveDirectRoomId(client, target);
  }
  if (target.startsWith("#")) {
    const resolved = await client.resolveRoom(target);
    if (!resolved) {
      throw new Error(`Matrix alias ${target} could not be resolved`);
    }
    return resolved;
  }
  return target;
}

type MatrixMediaMsgType =
  | typeof MsgType.Image
  | typeof MsgType.Audio
  | typeof MsgType.Video
  | typeof MsgType.File;

type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

function buildMatrixMediaInfo(params: {
  size: number;
  mimetype?: string;
  durationMs?: number;
  imageInfo?: DimensionalFileInfo;
}): MatrixMediaInfo | undefined {
  const base: FileWithThumbnailInfo = {};
  if (Number.isFinite(params.size)) {
    base.size = params.size;
  }
  if (params.mimetype) {
    base.mimetype = params.mimetype;
  }
  if (params.imageInfo) {
    const dimensional: DimensionalFileInfo = {
      ...base,
      ...params.imageInfo,
    };
    if (typeof params.durationMs === "number") {
      const videoInfo: VideoFileInfo = {
        ...dimensional,
        duration: params.durationMs,
      };
      return videoInfo;
    }
    return dimensional;
  }
  if (typeof params.durationMs === "number") {
    const timedInfo: TimedFileInfo = {
      ...base,
      duration: params.durationMs,
    };
    return timedInfo;
  }
  if (Object.keys(base).length === 0) return undefined;
  return base;
}

type MatrixFormattedContent = MessageEventContent & {
  format?: string;
  formatted_body?: string;
};

function buildMediaContent(params: {
  msgtype: MatrixMediaMsgType;
  body: string;
  url?: string;
  filename?: string;
  mimetype?: string;
  size: number;
  relation?: MatrixRelation;
  isVoice?: boolean;
  durationMs?: number;
  imageInfo?: DimensionalFileInfo;
  file?: EncryptedFile; // For encrypted media
}): MatrixMediaContent {
  const info = buildMatrixMediaInfo({
    size: params.size,
    mimetype: params.mimetype,
    durationMs: params.durationMs,
    imageInfo: params.imageInfo,
  });
  const base: MatrixMediaContent = {
    msgtype: params.msgtype,
    body: params.body,
    filename: params.filename,
    info: info ?? undefined,
  };
  // Encrypted media should only include the "file" payload, not top-level "url".
  if (!params.file && params.url) {
    base.url = params.url;
  }
  // For encrypted files, add the file object
  if (params.file) {
    base.file = params.file;
  }
  if (params.isVoice) {
    base["org.matrix.msc3245.voice"] = {};
    if (typeof params.durationMs === "number") {
      base["org.matrix.msc1767.audio"] = {
        duration: params.durationMs,
      };
    }
  }
  if (params.relation) {
    base["m.relates_to"] = params.relation;
  }
  applyMatrixFormatting(base, params.body);
  return base;
}

function buildTextContent(body: string, relation?: MatrixRelation): MatrixTextContent {
  const content: MatrixTextContent = relation
    ? {
        msgtype: MsgType.Text,
        body,
        "m.relates_to": relation,
      }
    : {
        msgtype: MsgType.Text,
        body,
      };
  applyMatrixFormatting(content, body);
  return content;
}

function applyMatrixFormatting(content: MatrixFormattedContent, body: string): void {
  const formatted = markdownToMatrixHtml(body ?? "");
  if (!formatted) return;
  content.format = "org.matrix.custom.html";
  content.formatted_body = formatted;
}

function buildReplyRelation(replyToId?: string): MatrixReplyRelation | undefined {
  const trimmed = replyToId?.trim();
  if (!trimmed) return undefined;
  return { "m.in_reply_to": { event_id: trimmed } };
}

function buildThreadRelation(threadId: string, replyToId?: string): MatrixThreadRelation {
  const trimmed = threadId.trim();
  return {
    rel_type: RelationType.Thread,
    event_id: trimmed,
    is_falling_back: true,
    "m.in_reply_to": { event_id: (replyToId?.trim() || trimmed) },
  };
}

function resolveMatrixMsgType(
  contentType?: string,
  fileName?: string,
): MatrixMediaMsgType {
  const kind = getCore().media.mediaKindFromMime(contentType ?? "");
  switch (kind) {
    case "image":
      return MsgType.Image;
    case "audio":
      return MsgType.Audio;
    case "video":
      return MsgType.Video;
    default:
      return MsgType.File;
  }
}

function resolveMatrixVoiceDecision(opts: {
  wantsVoice: boolean;
  contentType?: string;
  fileName?: string;
}): { useVoice: boolean } {
  if (!opts.wantsVoice) return { useVoice: false };
  if (getCore().media.isVoiceCompatibleAudio({ contentType: opts.contentType, fileName: opts.fileName })) {
    return { useVoice: true };
  }
  return { useVoice: false };
}

const THUMBNAIL_MAX_SIDE = 800;
const THUMBNAIL_QUALITY = 80;

async function prepareImageInfo(params: {
  buffer: Buffer;
  client: MatrixClient;
}): Promise<DimensionalFileInfo | undefined> {
  const meta = await getCore().media.getImageMetadata(params.buffer).catch(() => null);
  if (!meta) return undefined;
  const imageInfo: DimensionalFileInfo = { w: meta.width, h: meta.height };
  const maxDim = Math.max(meta.width, meta.height);
  if (maxDim > THUMBNAIL_MAX_SIDE) {
    try {
      const thumbBuffer = await getCore().media.resizeToJpeg({
        buffer: params.buffer,
        maxSide: THUMBNAIL_MAX_SIDE,
        quality: THUMBNAIL_QUALITY,
        withoutEnlargement: true,
      });
      const thumbMeta = await getCore().media.getImageMetadata(thumbBuffer).catch(() => null);
      const thumbUri = await params.client.uploadContent(
        thumbBuffer,
        "image/jpeg",
        "thumbnail.jpg",
      );
      imageInfo.thumbnail_url = thumbUri;
      if (thumbMeta) {
        imageInfo.thumbnail_info = {
          w: thumbMeta.width,
          h: thumbMeta.height,
          mimetype: "image/jpeg",
          size: thumbBuffer.byteLength,
        };
      }
    } catch {
      // Thumbnail generation failed, continue without it
    }
  }
  return imageInfo;
}

async function resolveMediaDurationMs(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  kind: MediaKind;
}): Promise<number | undefined> {
  if (params.kind !== "audio" && params.kind !== "video") return undefined;
  try {
    const fileInfo: IFileInfo | string | undefined =
      params.contentType || params.fileName
        ? {
            mimeType: params.contentType,
            size: params.buffer.byteLength,
            path: params.fileName,
          }
        : undefined;
    const metadata = await parseBuffer(params.buffer, fileInfo, {
      duration: true,
      skipCovers: true,
    });
    const durationSeconds = metadata.format.duration;
    if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
      return Math.max(0, Math.round(durationSeconds * 1000));
    }
  } catch {
    // Duration is optional; ignore parse failures.
  }
  return undefined;
}

async function uploadFile(
  client: MatrixClient,
  file: Buffer,
  params: {
    contentType?: string;
    filename?: string;
  },
): Promise<string> {
  return await client.uploadContent(file, params.contentType, params.filename);
}

/**
 * Upload media with optional encryption for E2EE rooms.
 */
async function uploadMediaMaybeEncrypted(
  client: MatrixClient,
  roomId: string,
  buffer: Buffer,
  params: {
    contentType?: string;
    filename?: string;
  },
): Promise<{ url: string; file?: EncryptedFile }> {
  // Check if room is encrypted and crypto is available
  const isEncrypted = client.crypto && await client.crypto.isRoomEncrypted(roomId);
  
  if (isEncrypted && client.crypto) {
    // Encrypt the media before uploading
    const encrypted = await client.crypto.encryptMedia(buffer);
    const mxc = await client.uploadContent(encrypted.buffer, params.contentType, params.filename);
    const file: EncryptedFile = { url: mxc, ...encrypted.file };
    return {
      url: mxc,
      file,
    };
  }
  
  // Upload unencrypted
  const mxc = await uploadFile(client, buffer, params);
  return { url: mxc };
}

async function resolveMatrixClient(opts: {
  client?: MatrixClient;
  timeoutMs?: number;
}): Promise<{ client: MatrixClient; stopOnDone: boolean }> {
  ensureNodeRuntime();
  if (opts.client) return { client: opts.client, stopOnDone: false };
  const active = getActiveMatrixClient();
  if (active) return { client: active, stopOnDone: false };
  const shouldShareClient = Boolean(process.env.CLAWDBOT_GATEWAY_PORT);
  if (shouldShareClient) {
    const client = await resolveSharedMatrixClient({
      timeoutMs: opts.timeoutMs,
    });
    return { client, stopOnDone: false };
  }
  const auth = await resolveMatrixAuth();
  const client = await createMatrixClient({
    homeserver: auth.homeserver,
    userId: auth.userId,
    accessToken: auth.accessToken,
    encryption: auth.encryption,
    localTimeoutMs: opts.timeoutMs,
  });
  if (auth.encryption && client.crypto) {
    try {
      const joinedRooms = await client.getJoinedRooms();
      await client.crypto.prepare(joinedRooms);
    } catch {
      // Ignore crypto prep failures for one-off sends; normal sync will retry.
    }
  }
  // matrix-bot-sdk uses start() instead of startClient()
  await client.start();
  return { client, stopOnDone: true };
}

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
  });
  try {
    const roomId = await resolveMatrixRoomId(client, to);
    const cfg = getCore().config.loadConfig();
    const textLimit = getCore().channel.text.resolveTextChunkLimit(cfg, "matrix");
    const chunkLimit = Math.min(textLimit, MATRIX_TEXT_LIMIT);
    const chunks = getCore().channel.text.chunkMarkdownText(trimmedMessage, chunkLimit);
    const threadId = normalizeThreadId(opts.threadId);
    const relation = threadId
      ? buildThreadRelation(threadId, opts.replyToId)
      : buildReplyRelation(opts.replyToId);
    const sendContent = async (content: MatrixOutboundContent) => {
      // matrix-bot-sdk uses sendMessage differently
      const eventId = await client.sendMessage(roomId, content);
      return eventId;
    };

    let lastMessageId = "";
    if (opts.mediaUrl) {
      const maxBytes = resolveMediaMaxBytes();
      const media = await getCore().media.loadWebMedia(opts.mediaUrl, maxBytes);
      const uploaded = await uploadMediaMaybeEncrypted(client, roomId, media.buffer, {
        contentType: media.contentType,
        filename: media.fileName,
      });
      const durationMs = await resolveMediaDurationMs({
        buffer: media.buffer,
        contentType: media.contentType,
        fileName: media.fileName,
        kind: media.kind,
      });
      const baseMsgType = resolveMatrixMsgType(media.contentType, media.fileName);
      const { useVoice } = resolveMatrixVoiceDecision({
        wantsVoice: opts.audioAsVoice === true,
        contentType: media.contentType,
        fileName: media.fileName,
      });
      const msgtype = useVoice ? MsgType.Audio : baseMsgType;
      const isImage = msgtype === MsgType.Image;
      const imageInfo = isImage ? await prepareImageInfo({ buffer: media.buffer, client }) : undefined;
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
        if (!text) continue;
        const followup = buildTextContent(text, followupRelation);
        const followupEventId = await sendContent(followup);
        lastMessageId = followupEventId ?? lastMessageId;
      }
    } else {
      for (const chunk of chunks.length ? chunks : [""]) {
        const text = chunk.trim();
        if (!text) continue;
        const content = buildTextContent(text, relation);
        const eventId = await sendContent(content);
        lastMessageId = eventId ?? lastMessageId;
      }
    }

    return {
      messageId: lastMessageId || "unknown",
      roomId,
    };
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
  });

  try {
    const roomId = await resolveMatrixRoomId(client, to);
    const pollContent = buildPollStartContent(poll);
    const threadId = normalizeThreadId(opts.threadId);
    const pollPayload = threadId
      ? { ...pollContent, "m.relates_to": buildThreadRelation(threadId) }
      : pollContent;
    // matrix-bot-sdk sendEvent returns eventId string directly
    const eventId = await client.sendEvent(roomId, M_POLL_START, pollPayload);

    return {
      eventId: eventId ?? "unknown",
      roomId,
    };
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
  if (!eventId?.trim()) return;
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
