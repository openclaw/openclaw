// Reference model of the Gateway's membership authority (owner-key spec section 7).
// Pure and in-memory: the Gateway owns persistence, transport and side effects; it can
// use these rules directly or must pass the same acceptance tests.
import { bytesToHex } from "../bytes.js";
import type { Ed25519PublicKey, IrohEndpointKey, KeyFingerprint } from "../keys.js";
import type {
  OwnerCapability,
  InviteCapBody,
  MemberRole,
  MembershipSnapshotBody,
  OwnerDeviceCertBody,
  SignedStatement,
  UnixSeconds,
} from "../statements/types.js";
import type { OwnerDeviceLookup, TrustAnchor, VerifyErrorCode } from "../statements/verify.js";
import { SUPPORTED_DESCRIPTOR_VERSIONS, SUPPORTED_STATEMENT_VERSIONS } from "../version.js";

/**
 * How a write reached the Gateway.
 * - `tunnel`: from an authenticated device over the iroh tunnel (relayed or direct path).
 * - `local_operator`: authenticated **direct loopback** (never traffic from the tunnel child).
 * - `mailbox`: through Discovery's per-claw mailbox.
 */
export type Channel = "tunnel" | "local_operator" | "mailbox";

/** Who approved an owner device: R (the recovery kit), or the fingerprint of an owner device. */
export type OwnerApprover = "root" | KeyFingerprint;

/** An owner device on this claw's allowlist. */
export type OwnerDeviceRecord = {
  cert: SignedStatement<"OwnerDeviceCert">;
  /**
   * Capabilities the Gateway granted: the certificate's caps, accepted only within its signer's
   * recorded caps (R may grant any). Signing checks and the snapshot read these, not the cert.
   */
  caps: OwnerCapability[];
  /** Who signed its certificate: R, or an owner device listed here at the time. */
  approved_by: OwnerApprover;
  /** Last tunnel admission of any of its peer keys (or when it was added), unix seconds. */
  last_seen: UnixSeconds;
  /**
   * The membership seq at which the device was listed; re-adding it while listed keeps it. A
   * revocation signed at an earlier seq does not cover it. Absent on records written before
   * listing seqs existed, which count as listed at 0.
   */
  listed_seq?: number;
  /** Per entry of `cert.body.peer_keys`, the seq at which that key was listed here (absent: 0). */
  peer_listed_seq?: number[];
};

/** A member and the browsers (peer keys) they use at this claw. */
export type MemberRecord = {
  role: MemberRole;
  peer_keys: IrohEndpointKey[];
  /** Last tunnel admission per peer key (or when it was added), unix seconds. */
  last_seen: Partial<Record<IrohEndpointKey, UnixSeconds>>;
  /**
   * Per entry of `peer_keys`, the membership seq at which that browser was listed; re-adding a
   * listed browser keeps it. Absent entries predate listing seqs and count as listed at 0.
   */
  listed_seq?: number[];
};

/** A registered invite. `proof_key` is hex and never leaves the Gateway. */
export type InviteRecord = {
  cap: InviteCapBody;
  proof_key: string;
  status: "open" | "pending" | "consumed";
  pending: {
    account_id: string;
    device_pub: Ed25519PublicKey;
    peer_key: IrohEndpointKey;
    requested_at: UnixSeconds;
  } | null;
  /**
   * Who registered it: R, or the owner device's fingerprint. Removing that device deletes the
   * invite while it is still open. Absent on invites registered before this was recorded.
   */
  created_by?: OwnerApprover;
};

/** The Gateway's membership state for one claw. */
export type AuthorityState = {
  claw_id: string;
  /** The root R pinned at linking. Only an owner reset on the machine replaces it (enrollment.md). */
  anchor: TrustAnchor;
  /** Monotonic membership seq; a MembershipChange must carry seq + 1. */
  seq: number;
  /** The owner allowlist, by fingerprint of the device key D. */
  owner_devices: Record<KeyFingerprint, OwnerDeviceRecord>;
  members: Record<string, MemberRecord>;
  invites: Record<string, InviteRecord>;
};

/** Side effects the Gateway must perform after a write. */
export type AuthorityEvent =
  | { type: "disconnect"; peer_keys: IrohEndpointKey[] }
  | { type: "invalidate_tokens"; peer_keys: IrohEndpointKey[] }
  | { type: "cancel_runs"; account_id: string }
  | {
      type: "notify_owners";
      event: "kit_used" | "redemption_pending" | "redemption_resolved";
      ref: string;
    }
  | { type: "publish_snapshot" };

/** Refusal codes: verification failures plus authority rules. */
export type AuthorityErrorCode =
  | VerifyErrorCode
  | "not_direct"
  | "not_local_operator"
  | "seq_conflict"
  | "invite_unknown"
  | "invite_used"
  | "invite_not_pending"
  | "target_mismatch"
  | "limit_reached"
  | "unsupported";

/** Result of a write. A refusal leaves the state unchanged and asks for no side effects. */
export type AuthorityResult =
  | { ok: true; status: "applied" | "pending"; state: AuthorityState; events: AuthorityEvent[] }
  | {
      ok: false;
      code: AuthorityErrorCode;
      detail: string;
      state: AuthorityState;
      events: AuthorityEvent[];
    };

/** Builds an accepted write: the new state and the effects the Gateway must perform. */
export function applied(state: AuthorityState, events: AuthorityEvent[] = []): AuthorityResult {
  return { ok: true, status: "applied", state, events };
}

/** Builds a refusal that changes nothing. */
export function refuse(
  state: AuthorityState,
  code: AuthorityErrorCode,
  detail: string,
): AuthorityResult {
  return { ok: false, code, detail, state, events: [] };
}

/** Tolerated clock skew for a certificate's `issued_at`, as in statement verification. */
export const CERT_CLOCK_SKEW_SECONDS = 300;

/**
 * Why an owner device certificate is outside its validity window at `now`, or
 * null when it is valid: issued in the future (beyond the clock skew) or expired.
 */
export function certificateWindowError(
  body: Pick<OwnerDeviceCertBody, "issued_at" | "expires_at">,
  now: UnixSeconds,
): { code: "not_yet_valid" | "expired"; detail: string } | null {
  if (body.issued_at > now + CERT_CLOCK_SKEW_SECONDS) {
    return { code: "not_yet_valid", detail: "certificate is issued in the future" };
  }
  if (body.expires_at !== null && body.expires_at <= now) {
    return { code: "expired", detail: "certificate expired" };
  }
  return null;
}

/**
 * "Make reachable" (spec section 4): pin R for good. Only over direct loopback,
 * never over the tunnel, even though tunnel traffic reaches the Gateway on loopback.
 */
export function linkClaw(
  input: { claw_id: string; root_pub: Ed25519PublicKey },
  channel: Channel,
): { ok: true; state: AuthorityState } | { ok: false; code: "not_local_operator" } {
  if (channel !== "local_operator") {
    return { ok: false, code: "not_local_operator" };
  }
  return {
    ok: true,
    state: {
      claw_id: input.claw_id,
      anchor: { root_pub: input.root_pub },
      seq: 0,
      owner_devices: {},
      members: {},
      invites: {},
    },
  };
}

/**
 * True when an owner device's certificate is, at `now`, within its validity window.
 * Listed devices are the allowlist; nothing else is consulted.
 */
export function isOwnerDeviceActive(record: OwnerDeviceRecord, now: UnixSeconds): boolean {
  return certificateWindowError(record.cert.body, now) === null;
}

/** Owner devices active at `now`. */
export function activeOwnerDevices(state: AuthorityState, now: UnixSeconds): OwnerDeviceRecord[] {
  return Object.values(state.owner_devices).filter((record) => isOwnerDeviceActive(record, now));
}

/** The current owner set as a verifier lookup: an active device's capabilities, by key. */
export function ownerLookup(state: AuthorityState, now: UnixSeconds): OwnerDeviceLookup {
  const caps = new Map(
    activeOwnerDevices(state, now).map((record) => [record.cert.body.device_pub, record.caps]),
  );
  return (devicePub) => caps.get(devicePub);
}

/**
 * The earliest moment after `now` at which a currently active owner device stops being
 * active because its certificate expires, or null if none expires. The Gateway closes
 * such a device's sessions at that boundary.
 */
export function nextOwnerExpiry(state: AuthorityState, now: UnixSeconds): UnixSeconds | null {
  let next: UnixSeconds | null = null;
  for (const record of activeOwnerDevices(state, now)) {
    const expiresAt = record.cert.body.expires_at;
    if (expiresAt !== null && (next === null || expiresAt < next)) {
      next = expiresAt;
    }
  }
  return next;
}

/**
 * Tunnel admission (the tunnel child asks this for every connection): the peer key
 * belongs to a member or to an owner device active at `now`. Discovery is not consulted,
 * so a withheld or delayed snapshot cannot keep a removed key admitted.
 */
export function isAdmitted(
  state: AuthorityState,
  peerKey: IrohEndpointKey,
  now: UnixSeconds,
): boolean {
  if (Object.values(state.members).some((member) => member.peer_keys.includes(peerKey))) {
    return true;
  }
  return activeOwnerDevices(state, now).some((record) =>
    record.cert.body.peer_keys.includes(peerKey),
  );
}

/** The snapshot body the Gateway signs with K_gw and publishes to Discovery: current state only. */
export function snapshotBody(
  state: AuthorityState,
  bindingSeq: number,
  now: UnixSeconds,
): MembershipSnapshotBody {
  const active = activeOwnerDevices(state, now);
  return {
    claw_id: state.claw_id,
    seq: state.seq,
    binding_seq: bindingSeq,
    owner_devices: active
      .map((record) => ({
        device_pub: record.cert.body.device_pub,
        caps: [...record.caps].toSorted(),
      }))
      .toSorted((a, b) => a.device_pub.localeCompare(b.device_pub)),
    owner_peer_keys: [
      ...new Set(active.flatMap((record) => record.cert.body.peer_keys)),
    ].toSorted(),
    members: Object.entries(state.members)
      .map(([account_id, member]) => ({
        account_id,
        role: member.role,
        peer_keys: member.peer_keys,
      }))
      .toSorted((a, b) => a.account_id.localeCompare(b.account_id)),
    protocols: {
      statement: [...SUPPORTED_STATEMENT_VERSIONS],
      descriptor: [...SUPPORTED_DESCRIPTOR_VERSIONS],
    },
    issued_at: now,
  };
}

/** Hex encoding used for stored proof keys. */
export function proofKeyHex(proofKey: Uint8Array): string {
  return bytesToHex(proofKey);
}
