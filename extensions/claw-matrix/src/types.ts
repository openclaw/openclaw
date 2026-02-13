// Matrix event types for Phase 1

export interface MatrixError {
  errcode: string;
  error: string;
  soft_logout?: boolean;
}

export interface MatrixSyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, MatrixJoinedRoom>;
    invite?: Record<string, MatrixInvitedRoom>;
    leave?: Record<string, unknown>;
  };
  account_data?: { events: MatrixEvent[] };
  to_device?: { events: MatrixEvent[] };
  device_one_time_keys_count?: Record<string, number>;
  device_unused_fallback_key_types?: string[];
  device_lists?: { changed?: string[]; left?: string[] };
}

export interface MatrixJoinedRoom {
  timeline?: { events: MatrixEvent[]; limited?: boolean; prev_batch?: string };
  state?: { events: MatrixEvent[] };
  ephemeral?: { events: MatrixEvent[] };
  account_data?: { events: MatrixEvent[] };
}

export interface MatrixInvitedRoom {
  invite_state?: { events: MatrixEvent[] };
}

export interface MatrixEvent {
  type: string;
  event_id?: string;
  sender?: string;
  origin_server_ts?: number;
  content: Record<string, unknown>;
  unsigned?: { age?: number; transaction_id?: string; redacted_because?: MatrixEvent };
  state_key?: string;
  room_id?: string;
  /** Pre-v1.11: redaction target event ID (top-level field on m.room.redaction events) */
  redacts?: string;
}

export interface MatrixRoomMessage {
  msgtype: string;
  body: string;
  format?: string;
  formatted_body?: string;
}

export interface MatrixEncryptedContent {
  algorithm: string;
  sender_key: string;
  ciphertext: unknown;
  session_id: string;
  device_id: string;
}

export interface UTDQueueEntry {
  event: MatrixEvent;
  roomId: string;
  queuedAt: number;
  retries: number;
}

export interface SendResult {
  eventId: string;
  roomId: string;
}

export interface MatrixFilterResponse {
  filter_id: string;
}

export interface MatrixLoginResponse {
  user_id: string;
  access_token: string;
  device_id: string;
}

export interface MatrixRelation {
  rel_type: string;
  event_id?: string;
  key?: string; // For m.annotation (reaction emoji)
  "m.in_reply_to"?: { event_id: string };
  is_falling_back?: boolean;
}

export interface MatrixEncryptedFile {
  url: string;
  key: JsonWebKey;
  iv: string;
  hashes: { sha256: string };
  v: "v2";
}

export interface MatrixMediaInfo {
  mimetype?: string;
  size?: number;
  w?: number;
  h?: number;
}

// ── Event Content Type Guards ─────────────────────────────────────────
// These narrow the generic Record<string, unknown> content to known shapes.

/** Content shape for m.room.message events. */
export interface MessageContent extends Record<string, unknown> {
  msgtype: string;
  body: string;
  format?: string;
  formatted_body?: string;
  url?: string;
  file?: MatrixEncryptedFile;
  info?: MatrixMediaInfo;
  "m.relates_to"?: MatrixRelation;
  "m.new_content"?: MessageContent;
}

/** Content shape for m.room.encrypted events. */
export interface EncryptedEventContent extends Record<string, unknown> {
  algorithm: string;
  sender_key: string;
  ciphertext: unknown;
  session_id: string;
  device_id?: string;
}

/** Content shape for m.reaction events. */
export interface ReactionContent extends Record<string, unknown> {
  "m.relates_to": {
    rel_type: "m.annotation";
    event_id: string;
    key: string;
  };
}

/** Content shape for m.room.member state events. */
export interface MemberContent extends Record<string, unknown> {
  membership: "invite" | "join" | "leave" | "ban" | "knock";
  displayname?: string;
  avatar_url?: string;
  reason?: string;
}

/** Content shape for m.room.redaction events (v1.11+). */
export interface RedactionContent extends Record<string, unknown> {
  redacts?: string;
  reason?: string;
}

// ── Type Guards ───────────────────────────────────────────────────────

export function isMessageContent(content: Record<string, unknown>): content is MessageContent {
  return typeof content.msgtype === "string" && typeof content.body === "string";
}

export function isEncryptedContent(
  content: Record<string, unknown>,
): content is EncryptedEventContent {
  return typeof content.algorithm === "string" && typeof content.sender_key === "string";
}

export function isReactionContent(content: Record<string, unknown>): content is ReactionContent {
  const rel = content["m.relates_to"] as Record<string, unknown> | undefined;
  return rel?.rel_type === "m.annotation" && typeof rel?.key === "string";
}

export function isMemberContent(content: Record<string, unknown>): content is MemberContent {
  return typeof content.membership === "string";
}
