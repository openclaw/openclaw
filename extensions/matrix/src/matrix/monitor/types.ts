import type { EncryptedFile, MessageEventContent } from "@vector-im/matrix-bot-sdk";

export const EventType = {
  RoomMessage: "m.room.message",
  RoomMessageEncrypted: "m.room.encrypted",
  RoomMember: "m.room.member",
  Location: "m.location",
  // Key verification event types
  VerificationRequest: "m.key.verification.request",
  VerificationReady: "m.key.verification.ready",
  VerificationStart: "m.key.verification.start",
  VerificationAccept: "m.key.verification.accept",
  VerificationKey: "m.key.verification.key",
  VerificationMac: "m.key.verification.mac",
  VerificationDone: "m.key.verification.done",
  VerificationCancel: "m.key.verification.cancel",
} as const;

export const RelationType = {
  Replace: "m.replace",
  Thread: "m.thread",
} as const;

export type MatrixRawEvent = {
  event_id: string;
  sender: string;
  type: string;
  origin_server_ts: number;
  content: Record<string, unknown>;
  unsigned?: {
    age?: number;
    redacted_because?: unknown;
  };
};

export type RoomMessageEventContent = MessageEventContent & {
  url?: string;
  file?: EncryptedFile;
  info?: {
    mimetype?: string;
    size?: number;
  };
  "m.relates_to"?: {
    rel_type?: string;
    event_id?: string;
    "m.in_reply_to"?: { event_id?: string };
  };
};
