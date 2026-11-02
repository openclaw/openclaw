// Signed statement bodies (owner-key spec section 3). Field names are the wire names.
import type { Ed25519PublicKey, IrohEndpointKey, KeyFingerprint } from "../keys.js";

/** Statement types. The type string is part of the signed domain-separation prefix. */
export const STATEMENT_TYPES = [
  "OwnerDeviceCert",
  "ServerBinding",
  "InviteCap",
  "MembershipChange",
  "Revocation",
  "RootRotation",
  "MembershipSnapshot",
  "InviteRedemption",
] as const;

/** One of {@link STATEMENT_TYPES}. */
export type StatementType = (typeof STATEMENT_TYPES)[number];

/** Unix time in whole seconds. */
export type UnixSeconds = number;

/** Capabilities an owner device certificate grants. A child certificate never exceeds its issuer's. */
export const OWNER_CAPABILITIES = ["approve_device", "bind", "invite", "manage_members"] as const;
/** One of {@link OWNER_CAPABILITIES}. */
export type OwnerCapability = (typeof OWNER_CAPABILITIES)[number];

/** Member roles, most privileged first. Invites grant at most `operator` (open question: final role set). */
export const MEMBER_ROLES = ["operator", "viewer"] as const;
/** One of {@link MEMBER_ROLES}. */
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Maximum OwnerDeviceCert chain length between a signing device and R. */
export const MAX_CHAIN_DEPTH = 4;

/** Certifies an owner device key D (and optionally its iroh peer keys W) for all of the owner's claws. */
export type OwnerDeviceCertBody = {
  device_pub: Ed25519PublicKey;
  peer_keys: IrohEndpointKey[];
  label: string;
  scope: "owner";
  caps: OwnerCapability[];
  issued_at: UnixSeconds;
  /** null = valid until revoked or the root rotates. */
  expires_at: UnixSeconds | null;
  root_epoch: number;
};

/** Binds a claw's hostname to its tunnel server key K_srv and Gateway signing key K_gw. */
export type ServerBindingBody = {
  claw_id: string;
  hostname: string;
  k_srv: IrohEndpointKey;
  k_gw: Ed25519PublicKey;
  /** Monotonic per claw; clients refuse a lower value than they have seen. */
  binding_seq: number;
  root_epoch: number;
  issued_at: UnixSeconds;
};

/** Who an invite is for, as asserted by OpenClaw ID (not a security boundary on its own). */
export type InviteAudience =
  | { kind: "account_id"; value: string }
  | { kind: "email"; value: string };

/** An invitation capability, registered directly at the Gateway. */
export type InviteCapBody = {
  claw_id: string;
  invite_id: string;
  role: MemberRole;
  audience: InviteAudience;
  label: string;
  created_at: UnixSeconds;
  expires_at: UnixSeconds;
  single_use: boolean;
  /** SHA-256 hex of the invite proof key (see invites.ts), never the link secret itself. */
  secret_hash: string;
};

/** Membership operations. */
export const MEMBERSHIP_OPS = [
  "add",
  "remove",
  "set_role",
  "revoke_device",
  "add_owner_device",
  "deny_invite",
] as const;
/** One of {@link MEMBERSHIP_OPS}. */
export type MembershipOp = (typeof MEMBERSHIP_OPS)[number];

/** Target of a membership change; which fields are required depends on `op`. */
export type MembershipTarget =
  | {
      op: "add";
      account_id: string;
      role: MemberRole;
      peer_keys: IrohEndpointKey[];
      invite_id: string | null;
    }
  | { op: "remove"; account_id: string }
  | { op: "set_role"; account_id: string; role: MemberRole }
  | { op: "revoke_device"; peer_key: IrohEndpointKey }
  | { op: "add_owner_device"; cert: SignedStatement<"OwnerDeviceCert"> }
  /** Owner declines a pending redemption; the invite is consumed and nothing is admitted. */
  | { op: "deny_invite"; invite_id: string };

/** A change to a claw's membership, written by an owner device (or R) directly at the Gateway. */
export type MembershipChangeBody = {
  claw_id: string;
  /** Must be the Gateway's current membership seq + 1 (compare-and-set; stops replays). */
  seq: number;
  target: MembershipTarget;
  issued_at: UnixSeconds;
};

/** What a revocation removes. */
export const REVOCATION_KINDS = ["owner_device", "peer_key", "server_key"] as const;
/** One of {@link REVOCATION_KINDS}. */
export type RevocationKind = (typeof REVOCATION_KINDS)[number];

/** Revokes a key by fingerprint. Owner scoped: applies at every claw that pins this root. */
export type RevocationBody = {
  target_fp: KeyFingerprint;
  target_kind: RevocationKind;
  reason: string;
  root_epoch: number;
  issued_at: UnixSeconds;
};

/** Hands owner authority from R to R' (signed by the old R). */
export type RootRotationBody = {
  old_root_fp: KeyFingerprint;
  new_root_pub: Ed25519PublicKey;
  new_epoch: number;
  issued_at: UnixSeconds;
};

/** One member entry in a snapshot. */
export type SnapshotMember = { account_id: string; role: MemberRole; peer_keys: IrohEndpointKey[] };

/** Gateway-signed (K_gw) mirror of membership for Discovery listing and relay admission. Not an authority. */
export type MembershipSnapshotBody = {
  claw_id: string;
  seq: number;
  binding_seq: number;
  /** Owner device peer keys the relay should admit. */
  owner_peer_keys: IrohEndpointKey[];
  members: SnapshotMember[];
  /** Fingerprints of revoked keys. */
  revoked: KeyFingerprint[];
  issued_at: UnixSeconds;
};

/** An invitee's request to redeem an invite; signed by the invitee's new device key D_I. */
export type InviteRedemptionBody = {
  claw_id: string;
  invite_id: string;
  account_id: string;
  device_pub: Ed25519PublicKey;
  peer_key: IrohEndpointKey;
  /** HMAC-SHA-256 hex under the invite proof key over the redemption proof input (invites.ts). */
  proof: string;
  requested_at: UnixSeconds;
};

/** Maps each statement type to its body. */
export type StatementBodies = {
  OwnerDeviceCert: OwnerDeviceCertBody;
  ServerBinding: ServerBindingBody;
  InviteCap: InviteCapBody;
  MembershipChange: MembershipChangeBody;
  Revocation: RevocationBody;
  RootRotation: RootRotationBody;
  MembershipSnapshot: MembershipSnapshotBody;
  InviteRedemption: InviteRedemptionBody;
};

/**
 * The signed envelope: `{ v, type, body, signer, chain, alg, sig }`.
 *
 * `signer` carries the full public key (not only its fingerprint) so a verifier that
 * pinned only fp(R) can check R's signatures. `chain` lists OwnerDeviceCerts from the
 * signer's own certificate up to the one R signed; chain entries carry an empty chain.
 */
export type SignedStatement<T extends StatementType = StatementType> = {
  v: 1;
  type: T;
  body: StatementBodies[T];
  signer: Ed25519PublicKey;
  chain: SignedStatement<"OwnerDeviceCert">[];
  alg: "ed25519";
  /** Unpadded base64url Ed25519 signature over the signing input. */
  sig: string;
};
