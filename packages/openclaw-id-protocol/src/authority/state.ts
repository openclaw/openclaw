// Reference model of the Gateway's membership authority (owner-key spec section 7).
// Pure and in-memory: the Gateway owns persistence, transport and side effects; it can
// use these rules directly or must pass the same acceptance tests.
import { bytesToHex } from "../bytes.js";
import type { Ed25519PublicKey, IrohEndpointKey, KeyFingerprint } from "../keys.js";
import type {
  InviteCapBody,
  MemberRole,
  MembershipSnapshotBody,
  OwnerDeviceCertBody,
  SignedStatement,
  UnixSeconds,
} from "../statements/types.js";
import type { TrustAnchor, VerifyErrorCode } from "../statements/verify.js";

/**
 * How a write reached the Gateway.
 * - `tunnel`: from an authenticated device over the iroh tunnel (relayed or direct path).
 * - `local_operator`: authenticated **direct loopback** (never traffic from the tunnel child).
 * - `mailbox`: through Discovery's per-claw mailbox.
 */
export type Channel = "tunnel" | "local_operator" | "mailbox";

/** An owner device the Gateway knows, with the fingerprints of its certificate chain. */
export type OwnerDeviceRecord = {
  cert: SignedStatement<"OwnerDeviceCert">;
  /** fp of the device and of every device in its chain (for revocation checks). */
  chain_fps: KeyFingerprint[];
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
};

/** The Gateway's membership state for one claw. */
export type AuthorityState = {
  claw_id: string;
  anchor: TrustAnchor;
  /** Root public key per epoch (for detecting conflicting rotations). */
  root_history: Record<number, Ed25519PublicKey>;
  /** Signature of the accepted rotation into each epoch. */
  rotation_seen: Record<number, string>;
  /** Remote root changes frozen after conflicting rotations, until the local operator resolves it. */
  frozen: boolean;
  /** Monotonic membership seq; a MembershipChange must carry seq + 1. */
  seq: number;
  owner_devices: Record<KeyFingerprint, OwnerDeviceRecord>;
  members: Record<string, { role: MemberRole; peer_keys: IrohEndpointKey[] }>;
  invites: Record<string, InviteRecord>;
  revoked: KeyFingerprint[];
};

/** Side effects the Gateway must perform after a write. */
export type AuthorityEvent =
  | { type: "disconnect"; peer_keys: IrohEndpointKey[] }
  | { type: "invalidate_tokens"; peer_keys: IrohEndpointKey[] }
  | { type: "cancel_runs"; account_id: string }
  | {
      type: "notify_owners";
      event: "kit_used" | "redemption_pending" | "redemption_resolved" | "rotation_conflict";
      ref: string;
    }
  | { type: "publish_snapshot" };

/** Refusal codes: verification failures plus authority rules. */
export type AuthorityErrorCode =
  | VerifyErrorCode
  | "not_direct"
  | "not_local_operator"
  | "seq_conflict"
  | "frozen"
  | "root_reused"
  | "invite_unknown"
  | "invite_used"
  | "invite_not_pending"
  | "target_mismatch"
  | "unsupported";

/**
 * Result of a write. A refusal leaves the state unchanged unless `persist` is true:
 * then the statement is still refused, but `state` carries a security transition
 * (the conflicting-rotation freeze) that the Gateway must persist, and `events` the
 * side effects it must perform, before it reports the refusal.
 */
export type AuthorityResult =
  | { ok: true; status: "applied" | "pending"; state: AuthorityState; events: AuthorityEvent[] }
  | {
      ok: false;
      code: AuthorityErrorCode;
      detail: string;
      state: AuthorityState;
      events: AuthorityEvent[];
      persist?: true;
    };

/** Builds a refusal that changes nothing. */
export function refuse(
  state: AuthorityState,
  code: AuthorityErrorCode,
  detail: string,
): AuthorityResult {
  return { ok: false, code, detail, state, events: [] };
}

/**
 * Builds a refusal that still moves the claw into a safer state (`next`) and asks
 * for side effects. The Gateway persists `next` and performs `events`.
 */
export function refuseWithTransition(
  next: AuthorityState,
  code: AuthorityErrorCode,
  detail: string,
  events: AuthorityEvent[],
): AuthorityResult {
  return { ok: false, code, detail, state: next, events, persist: true };
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
 * "Make reachable" (spec section 4): pin fp(R) and epoch 1. Only over direct loopback,
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
      anchor: { root_pub: input.root_pub, root_epoch: 1 },
      root_history: { 1: input.root_pub },
      rotation_seen: {},
      frozen: false,
      seq: 0,
      owner_devices: {},
      members: {},
      invites: {},
      revoked: [],
    },
  };
}

/**
 * The epoch a re-pinned or regenerated root starts: one past every epoch this claw
 * has seen, so a certificate from any earlier root can never become current again.
 */
export function nextRootEpoch(state: AuthorityState): number {
  return Math.max(state.anchor.root_epoch, ...Object.keys(state.root_history).map(Number)) + 1;
}

/** Every tunnel key certified by an owner device the claw knows, in any epoch. */
export function ownerDevicePeerKeys(state: AuthorityState): IrohEndpointKey[] {
  return [
    ...new Set(Object.values(state.owner_devices).flatMap((record) => record.cert.body.peer_keys)),
  ];
}

/**
 * True when an owner device's certificate is in the current epoch, nothing in its
 * chain is revoked, and at `now` the certificate and every ancestor in its chain
 * are within their validity windows.
 */
export function isOwnerDeviceActive(
  state: AuthorityState,
  record: OwnerDeviceRecord,
  now: UnixSeconds,
): boolean {
  return (
    record.cert.body.root_epoch === state.anchor.root_epoch &&
    record.chain_fps.every((fp) => !state.revoked.includes(fp)) &&
    [record.cert, ...record.cert.chain].every(
      (cert) => certificateWindowError(cert.body, now) === null,
    )
  );
}

/**
 * The earliest moment after `now` at which a currently active owner device stops
 * being active because its certificate or an ancestor expires, or null if none
 * expires. The Gateway closes such a device's sessions at that boundary.
 */
export function nextOwnerExpiry(state: AuthorityState, now: UnixSeconds): UnixSeconds | null {
  let next: UnixSeconds | null = null;
  for (const record of Object.values(state.owner_devices)) {
    if (!isOwnerDeviceActive(state, record, now)) {
      continue;
    }
    for (const cert of [record.cert, ...record.cert.chain]) {
      const expiresAt = cert.body.expires_at;
      if (expiresAt !== null && (next === null || expiresAt < next)) {
        next = expiresAt;
      }
    }
  }
  return next;
}

/**
 * Tunnel admission (the tunnel child asks this for every connection): the peer key
 * belongs to an owner device active at `now` or a member and is not revoked. Discovery
 * is not consulted, so a withheld or delayed snapshot cannot keep a removed key admitted.
 */
export function isAdmitted(
  state: AuthorityState,
  peerKey: IrohEndpointKey,
  peerKeyFp: KeyFingerprint,
  now: UnixSeconds,
): boolean {
  if (state.revoked.includes(peerKeyFp)) {
    return false;
  }
  if (Object.values(state.members).some((member) => member.peer_keys.includes(peerKey))) {
    return true;
  }
  return Object.values(state.owner_devices).some(
    (record) =>
      isOwnerDeviceActive(state, record, now) && record.cert.body.peer_keys.includes(peerKey),
  );
}

/** The snapshot body the Gateway signs with K_gw and publishes to Discovery. */
export function snapshotBody(
  state: AuthorityState,
  bindingSeq: number,
  now: UnixSeconds,
): MembershipSnapshotBody {
  const ownerPeerKeys = Object.values(state.owner_devices)
    .filter((record) => isOwnerDeviceActive(state, record, now))
    .flatMap((record) => record.cert.body.peer_keys);
  return {
    claw_id: state.claw_id,
    seq: state.seq,
    binding_seq: bindingSeq,
    owner_peer_keys: [...new Set(ownerPeerKeys)].toSorted(),
    members: Object.entries(state.members)
      .map(([account_id, member]) => ({
        account_id,
        role: member.role,
        peer_keys: member.peer_keys,
      }))
      .toSorted((a, b) => a.account_id.localeCompare(b.account_id)),
    revoked: [...state.revoked].toSorted(),
    issued_at: now,
  };
}

/** Hex encoding used for stored proof keys. */
export function proofKeyHex(proofKey: Uint8Array): string {
  return bytesToHex(proofKey);
}
