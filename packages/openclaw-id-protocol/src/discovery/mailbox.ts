// Per-claw mailbox: store-and-forward of opaque, end-to-end authenticated messages.
import { isKeyFingerprint, type KeyFingerprint } from "../keys.js";
import type { SignedStatement, UnixSeconds } from "../statements/types.js";

/** Who reads a message: the claw's Gateway, every owner device, or one device by key fingerprint. */
export type MailboxRecipient = "gateway" | "owners" | KeyFingerprint;

/** SAS enrollment steps carried through the mailbox (owner-key spec section 6.1). */
export const ENROLLMENT_STEPS = ["start", "accept", "key", "sealed", "abort"] as const;
/** One of {@link ENROLLMENT_STEPS}. */
export type EnrollmentStep = (typeof ENROLLMENT_STEPS)[number];

/**
 * Notice events the Gateway may mail. `seq_conflict` tells the one device whose root statement
 * was refused for a stale seq that the Gateway has republished its snapshot; its `ref` is the
 * Gateway's current seq. `rebind` tells every owner device that the claw moved to new machine
 * keys; its `ref` is the new binding_seq. Every other event goes to all owner devices.
 */
export const MAILBOX_NOTICE_EVENTS = [
  "kit_used",
  "redemption_pending",
  "redemption_resolved",
  "seq_conflict",
  "rebind",
] as const;
/** One of {@link MAILBOX_NOTICE_EVENTS}. */
export type MailboxNoticeEvent = (typeof MAILBOX_NOTICE_EVENTS)[number];

/** Longest notice `ref` (an invite id, key fingerprint or decimal seq). */
export const MAILBOX_NOTICE_REF_MAX_LENGTH = 128;

/** Message payloads. Every security-relevant payload is a signed statement the reader verifies. */
export type MailboxPayload =
  | { kind: "node_redemption"; redemption: SignedStatement<"NodeRedemption"> }
  | { kind: "invite_redemption"; redemption: SignedStatement<"InviteRedemption"> }
  /** R-signed statements: kit enrollment (add_owner_device) and other root changes. */
  | { kind: "root_statement"; statements: SignedStatement[] }
  | { kind: "revocation"; revocation: SignedStatement<"Revocation"> }
  /** SAS enrollment messages; `data` per step is defined in docs/discovery.md. */
  | { kind: "enrollment"; request_id: string; step: EnrollmentStep; data: Record<string, unknown> }
  /**
   * Gateway hints to devices. Never authority: devices confirm at the Gateway directly (a
   * `seq_conflict` device re-reads the K_gw-signed snapshot before signing again).
   */
  | { kind: "notice"; event: MailboxNoticeEvent; ref: string };

/**
 * Whether a notice may go to a recipient: `seq_conflict` only to one device fingerprint (the
 * refused sender), `rebind` only to all owner devices, every other event to the owner devices
 * or one device.
 */
export function noticeRecipientAllowed(event: MailboxNoticeEvent, to: MailboxRecipient): boolean {
  if (to === "gateway") {
    return false;
  }
  if (event === "rebind") {
    return to === "owners";
  }
  return event === "seq_conflict" ? isKeyFingerprint(to) : true;
}

/**
 * Checks a notice's event and `ref`; for `seq_conflict` the ref must be the Gateway's current
 * seq and for `rebind` the new binding_seq, in decimal (no sign, no leading zeros, at most 15
 * digits).
 */
export function isValidNotice(event: unknown, ref: unknown): event is MailboxNoticeEvent {
  // SAFETY: widening a literal tuple to its element supertype only for the membership test.
  if (!(MAILBOX_NOTICE_EVENTS as readonly unknown[]).includes(event) || typeof ref !== "string") {
    return false;
  }
  if (ref.length === 0 || ref.length > MAILBOX_NOTICE_REF_MAX_LENGTH) {
    return false;
  }
  return (event !== "seq_conflict" && event !== "rebind") || parseSeqConflictRef(ref) !== undefined;
}

/** The Gateway's current seq from a `seq_conflict` notice ref, or undefined if malformed. */
export function parseSeqConflictRef(ref: string): number | undefined {
  return /^(0|[1-9][0-9]{0,14})$/.test(ref) ? Number(ref) : undefined;
}

/** Payload kinds the Gateway accepts from its mailbox. Device-signed MembershipChanges are not among them. */
export const GATEWAY_MAILBOX_KINDS = [
  "invite_redemption",
  "node_redemption",
  "root_statement",
  "revocation",
] as const;

/** Sender identity as asserted by OpenClaw ID; display only, never authority. */
export type ReportedSender = {
  account_id: string;
  email: string | null;
  display_name: string | null;
  /** Fingerprint of the sending device key, when the request was device-signed. */
  device_fp: KeyFingerprint | null;
  reported_by: "openclaw-id";
};

/** A node has no asserted account; its fingerprint names W, never an owner device D. */
export type ReportedNodeSender = {
  account_id: null;
  email: null;
  display_name: null;
  device_fp: KeyFingerprint;
  reported_by: "openclaw-id";
};

/** A stored message as returned to its reader. */
export type MailboxMessage = {
  message_id: string;
  claw_id: string;
  to: MailboxRecipient;
  from: ReportedSender | ReportedNodeSender;
  /** Coarse location hint for approval prompts ("reported by OpenClaw ID"). */
  location_hint: string | null;
  payload: MailboxPayload;
  received_at: UnixSeconds;
  expires_at: UnixSeconds;
};

/** Largest accepted payload (JSON bytes). */
export const MAILBOX_MAX_PAYLOAD_BYTES = 64 * 1024;
/** Message lifetime: matches the 7-day pending redemption window. */
export const MAILBOX_TTL_SECONDS = 7 * 86400;
/** Longest long-poll wait a reader may request. */
export const MAILBOX_MAX_WAIT_SECONDS = 30;
