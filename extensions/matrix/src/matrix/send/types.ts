import type {
  DimensionalFileInfo,
  EncryptedFile,
  FileWithThumbnailInfo,
  MessageEventContent,
  TextualMessageEventContent,
  TimedFileInfo,
  VideoFileInfo,
} from "@vector-im/matrix-bot-sdk";

// Message types
export const MsgType = {
  Text: "m.text",
  Image: "m.image",
  Audio: "m.audio",
  Video: "m.video",
  File: "m.file",
  Notice: "m.notice",
} as const;

// Relation types
export const RelationType = {
  Annotation: "m.annotation",
  Replace: "m.replace",
  Thread: "m.thread",
} as const;

// Event types
export const EventType = {
  Direct: "m.direct",
  Reaction: "m.reaction",
  RoomMessage: "m.room.message",
} as const;

export type MatrixDirectAccountData = Record<string, string[]>;

export type MatrixReplyRelation = {
  "m.in_reply_to": { event_id: string };
};

export type MatrixThreadRelation = {
  rel_type: typeof RelationType.Thread;
  event_id: string;
  is_falling_back?: boolean;
  "m.in_reply_to"?: { event_id: string };
};

export type MatrixRelation = MatrixReplyRelation | MatrixThreadRelation;

export type MatrixReplyMeta = {
  "m.relates_to"?: MatrixRelation;
};

export type MatrixMediaInfo =
  | FileWithThumbnailInfo
  | DimensionalFileInfo
  | TimedFileInfo
  | VideoFileInfo;

export type MatrixTextContent = TextualMessageEventContent & MatrixReplyMeta;

// 注意：MatrixMediaContent 使用 Exclude 排除 TextualMessageEventContent，
// 因为 TextualMessageEventContent 是 MessageEventContent 的子类型，
// 这样可以避免联合类型中出现重复类型成员
// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export type MatrixMediaContent = (Exclude<
  MessageEventContent,
  TextualMessageEventContent
> extends never
  ? MessageEventContent
  : Exclude<MessageEventContent, TextualMessageEventContent>) &
  MatrixReplyMeta & {
    info?: MatrixMediaInfo;
    url?: string;
    file?: EncryptedFile;
    filename?: string;
    "org.matrix.msc3245.voice"?: Record<string, never>;
    "org.matrix.msc1767.audio"?: { duration: number };
  };

// eslint-disable-next-line @typescript-eslint/no-redundant-type-constituents
export type MatrixOutboundContent = MatrixTextContent | MatrixMediaContent;

export type ReactionEventContent = {
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
  client?: import("@vector-im/matrix-bot-sdk").MatrixClient;
  mediaUrl?: string;
  accountId?: string;
  replyToId?: string;
  threadId?: string | number | null;
  timeoutMs?: number;
  /** Send audio as voice message (voice bubble) instead of audio file. Defaults to false. */
  audioAsVoice?: boolean;
};

export type MatrixMediaMsgType =
  | typeof MsgType.Image
  | typeof MsgType.Audio
  | typeof MsgType.Video
  | typeof MsgType.File;

export type MediaKind = "image" | "audio" | "video" | "document" | "unknown";

export type MatrixFormattedContent = MessageEventContent & {
  format?: string;
  formatted_body?: string;
};
