/**
 * Matrix key verification event types (MSC3903 / Matrix spec v1.8).
 *
 * Covers both to-device and in-room verification flows.
 * In-room verification requests arrive as `m.room.message` with
 * `msgtype: "m.key.verification.request"`.
 */

// ---------------------------------------------------------------------------
// Event type constants
// ---------------------------------------------------------------------------

export const VerificationEventType = {
  Request: "m.key.verification.request",
  Ready: "m.key.verification.ready",
  Start: "m.key.verification.start",
  Accept: "m.key.verification.accept",
  Key: "m.key.verification.key",
  Mac: "m.key.verification.mac",
  Done: "m.key.verification.done",
  Cancel: "m.key.verification.cancel",
} as const;

export type VerificationEventTypeValue =
  (typeof VerificationEventType)[keyof typeof VerificationEventType];

// ---------------------------------------------------------------------------
// Cancellation codes (Matrix spec)
// ---------------------------------------------------------------------------

export const CancelCode = {
  User: "m.user",
  Timeout: "m.timeout",
  UnknownTransaction: "m.unknown_transaction",
  UnknownMethod: "m.unknown_method",
  UnexpectedMessage: "m.unexpected_message",
  KeyMismatch: "m.key_mismatch",
  UserMismatch: "m.user_mismatch",
  InvalidMessage: "m.invalid_message",
  Accepted: "m.accepted",
  MismatchedCommitment: "m.mismatched_commitment",
  MismatchedSas: "m.mismatched_sas",
} as const;

// ---------------------------------------------------------------------------
// Content types for each verification event
// ---------------------------------------------------------------------------

/** m.key.verification.request (to-device) or m.room.message with msgtype m.key.verification.request (in-room) */
export type VerificationRequestContent = {
  from_device: string;
  methods: string[];
  /** Only present in to-device events */
  transaction_id?: string;
  /** Only present in in-room events (msgtype) */
  msgtype?: string;
  body?: string;
  /** Timestamp (in-room events use the event's origin_server_ts) */
  timestamp?: number;
};

/** m.key.verification.ready */
export type VerificationReadyContent = {
  from_device: string;
  methods: string[];
  transaction_id?: string;
  /** In-room: relates to the request event via m.reference */
  "m.relates_to"?: VerificationRelation;
};

/** m.key.verification.start */
export type VerificationStartContent = {
  from_device: string;
  method: string;
  transaction_id?: string;
  key_agreement_protocols: string[];
  hashes: string[];
  message_authentication_codes: string[];
  short_authentication_string: string[];
  "m.relates_to"?: VerificationRelation;
};

/** m.key.verification.accept */
export type VerificationAcceptContent = {
  transaction_id?: string;
  method: string;
  key_agreement_protocol: string;
  hash: string;
  message_authentication_code: string;
  short_authentication_string: string[];
  commitment: string;
  "m.relates_to"?: VerificationRelation;
};

/** m.key.verification.key */
export type VerificationKeyContent = {
  transaction_id?: string;
  key: string;
  "m.relates_to"?: VerificationRelation;
};

/** m.key.verification.mac */
export type VerificationMacContent = {
  transaction_id?: string;
  mac: Record<string, string>;
  keys: string;
  "m.relates_to"?: VerificationRelation;
};

/** m.key.verification.done */
export type VerificationDoneContent = {
  transaction_id?: string;
  "m.relates_to"?: VerificationRelation;
};

/** m.key.verification.cancel */
export type VerificationCancelContent = {
  transaction_id?: string;
  code: string;
  reason: string;
  "m.relates_to"?: VerificationRelation;
};

// ---------------------------------------------------------------------------
// Shared relation type for in-room verification
// ---------------------------------------------------------------------------

export type VerificationRelation = {
  rel_type: "m.reference";
  event_id: string;
};

// ---------------------------------------------------------------------------
// Union type for all verification content
// ---------------------------------------------------------------------------

export type VerificationContent =
  | VerificationRequestContent
  | VerificationReadyContent
  | VerificationStartContent
  | VerificationAcceptContent
  | VerificationKeyContent
  | VerificationMacContent
  | VerificationDoneContent
  | VerificationCancelContent;

// ---------------------------------------------------------------------------
// Raw event shape (mirrors MatrixRawEvent but typed for verification)
// ---------------------------------------------------------------------------

export type VerificationRawEvent = {
  event_id?: string;
  sender: string;
  type: string;
  origin_server_ts?: number;
  content: Record<string, unknown>;
  unsigned?: {
    age?: number;
  };
};

// ---------------------------------------------------------------------------
// SAS session state machine
// ---------------------------------------------------------------------------

export type SasSessionState =
  | "requested"
  | "ready"
  | "started"
  | "accepted"
  | "key_exchanged"
  | "sas_shown"
  | "mac_sent"
  | "mac_received"
  | "done"
  | "cancelled";

export type SasSession = {
  transactionId: string;
  /** Whether this is an in-room verification (vs to-device) */
  inRoom: boolean;
  /** Room ID if in-room verification */
  roomId?: string;
  /** The event ID of the original request (for in-room m.reference relations) */
  requestEventId?: string;
  /** Remote user ID */
  remoteUserId: string;
  /** Remote device ID */
  remoteDeviceId: string;
  /** Our user ID */
  selfUserId: string;
  /** Our device ID */
  selfDeviceId: string;
  /** Current state */
  state: SasSessionState;
  /** Our ephemeral X25519 key pair */
  keyPair?: { publicKey: Buffer; privateKey: Buffer };
  /** Our public key in unpadded base64 */
  ourPublicKeyBase64?: string;
  /** Their public key in unpadded base64 */
  theirPublicKeyBase64?: string;
  /** Shared secret from ECDH */
  sharedSecret?: Buffer;
  /** The m.key.verification.start content (canonical JSON for commitment) */
  startContent?: VerificationStartContent;
  /** Our commitment hash (if we are the accepter) */
  commitment?: string;
  /** Computed SAS bytes */
  sasBytes?: Buffer;
  /** Who initiated: "us" or "them" */
  initiator: "us" | "them";
  /** Timestamp of creation */
  createdAt: number;
  /** Selected MAC method */
  macMethod?: string;
};
