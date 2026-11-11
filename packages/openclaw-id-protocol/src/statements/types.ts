// Signed statement bodies (owner-key spec section 3). Field names are the wire names.
import type { Ed25519PublicKey, IrohEndpointKey, KeyFingerprint } from "../keys.js";
import type { StatementVersion } from "../version.js";

/** Statement types. The type string is part of the signed domain-separation prefix. */
export const STATEMENT_TYPES = [
  "OwnerDeviceCert",
  "ServerBinding",
  "InviteCap",
  "MembershipChange",
  "Revocation",
  "MembershipSnapshot",
  "InviteRedemption",
  "RootReset",
] as const;

/** One of {@link STATEMENT_TYPES}. */
export type StatementType = (typeof STATEMENT_TYPES)[number];

/** Unix time in whole seconds. */
export type UnixSeconds = number;

/**
 * The only root epoch in v1-draft. There are no root epochs: an owner reset replaces the root
 * without one (RootReset), so `root_epoch` is a constant: statements carry it, and anything
 * else is malformed.
 */
export const ROOT_EPOCH = 1;

/** Capabilities an owner device certificate grants. A certificate never grants more than its approver holds. */
export const OWNER_CAPABILITIES = ["approve_device", "bind", "invite", "manage_members"] as const;
/** One of {@link OWNER_CAPABILITIES}. */
export type OwnerCapability = (typeof OWNER_CAPABILITIES)[number];

/** Member roles, most privileged first. Invites grant at most `operator` (open question: final role set). */
export const MEMBER_ROLES = ["operator", "viewer"] as const;
/** One of {@link MEMBER_ROLES}. */
export type MemberRole = (typeof MEMBER_ROLES)[number];

/** Most owner devices one claw keeps. Adding past it is refused with `limit_reached`. */
export const MAX_OWNER_DEVICES = 20;
/** Most iroh peer keys one owner device certificate may carry. */
export const MAX_OWNER_DEVICE_PEER_KEYS = 10;
/**
 * Most members one claw keeps. It equals the statement list limit, so a snapshot listing every
 * member still validates.
 */
export const MAX_MEMBERS = 256;
/** Most iroh peer keys (browsers) one member may have at a claw. */
export const MAX_MEMBER_PEER_KEYS = 10;
/** Most invites one claw keeps, in any state. Registering past it is refused with `limit_reached`. */
export const MAX_INVITES = 100;

/**
 * Certifies an owner device key D (and optionally its iroh peer keys W). It is signed by R or by
 * an owner device the claw currently lists, and admits D only at a claw that adds it.
 */
export type OwnerDeviceCertBody = {
  device_pub: Ed25519PublicKey;
  peer_keys: IrohEndpointKey[];
  label: string;
  scope: "owner";
  caps: OwnerCapability[];
  issued_at: UnixSeconds;
  /** null = valid until removed. */
  expires_at: UnixSeconds | null;
  /** Always {@link ROOT_EPOCH}; anything else is malformed. */
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
  /** Always {@link ROOT_EPOCH}; anything else is malformed. */
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

/** What a revocation removes: an owner device (with every device it approved) or a peer key. */
export const REVOCATION_KINDS = ["owner_device", "peer_key"] as const;
/** One of {@link REVOCATION_KINDS}. */
export type RevocationKind = (typeof REVOCATION_KINDS)[number];

/**
 * Removes a key by fingerprint from one claw. It covers only what its signer saw: a key listed
 * at or before `seq`. A key listed again after that seq is a new approval it does not cover, so
 * the same bytes submitted later change nothing. Nothing remembers the revocation afterwards.
 */
export type RevocationBody = {
  claw_id: string;
  /** The claw's membership seq the signer last saw (the snapshot's seq). */
  seq: number;
  target_fp: KeyFingerprint;
  target_kind: RevocationKind;
  reason: string;
  /** Always {@link ROOT_EPOCH}; anything else is malformed. */
  root_epoch: number;
  issued_at: UnixSeconds;
};

/** One owner device in a snapshot: its key D and the capabilities the Gateway granted it. */
export type SnapshotOwnerDevice = { device_pub: Ed25519PublicKey; caps: OwnerCapability[] };

/** One member entry in a snapshot. */
export type SnapshotMember = { account_id: string; role: MemberRole; peer_keys: IrohEndpointKey[] };

/**
 * Protocol versions a Gateway accepts for new input, per versioned surface, ascending. Clients
 * pick the highest version they share with it (`selectVersion`). The tunnel is not listed: its
 * version is negotiated by QUIC ALPN inside the handshake K_srv authenticates.
 */
export type ProtocolVersions = {
  /** Signed statement envelope versions. */
  statement: number[];
  /** ClawDescriptor versions. */
  descriptor: number[];
};

/**
 * Gateway-signed (K_gw) mirror of the claw's current allowlist for Discovery listing and relay
 * admission. Not an authority, and it carries no history: a removed key is simply absent.
 */
export type MembershipSnapshotBody = {
  claw_id: string;
  seq: number;
  binding_seq: number;
  /**
   * The current owner devices with their granted capabilities. Readers outside the claw take
   * an owner device's capabilities from here, never from a certificate a browser presents.
   */
  owner_devices: SnapshotOwnerDevice[];
  /** Owner device peer keys the relay should admit. */
  owner_peer_keys: IrohEndpointKey[];
  members: SnapshotMember[];
  /**
   * The versions this Gateway accepts. Signed by K_gw and only used from a snapshot that passed
   * `assessFreshness`, so Discovery cannot edit it. It can still replay an older list a client
   * has not seen; the Gateway refusing unlisted versions is what keeps that harmless.
   */
  protocols: ProtocolVersions;
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

/**
 * Owner reset (OCF-319): the Gateway, with the K_gw of the claw's current binding, vouches that
 * the claw's root is now `new_root_pub` from `binding_seq` on. Reset only happens on the claw's
 * machine. It keeps K_srv and K_gw, so the new binding (signed by the new root at this
 * binding_seq) names the same keys as the binding it replaces.
 */
export type RootResetBody = {
  claw_id: string;
  new_root_pub: Ed25519PublicKey;
  /** The new binding's binding_seq: higher than the binding the reset replaces. */
  binding_seq: number;
  issued_at: UnixSeconds;
};

/** Maps each statement type to its body. */
export type StatementBodies = {
  OwnerDeviceCert: OwnerDeviceCertBody;
  ServerBinding: ServerBindingBody;
  InviteCap: InviteCapBody;
  MembershipChange: MembershipChangeBody;
  Revocation: RevocationBody;
  MembershipSnapshot: MembershipSnapshotBody;
  InviteRedemption: InviteRedemptionBody;
  RootReset: RootResetBody;
};

/**
 * The signed envelope: `{ v, type, body, signer, alg, sig }`.
 *
 * `signer` carries the full public key (not only its fingerprint) so a verifier that
 * pinned only fp(R) can check R's signatures. A statement signed by an owner device is
 * checked against the claw's current owner devices, which only the Gateway knows.
 */
export type SignedStatement<T extends StatementType = StatementType> = {
  /** Envelope version; selects the schema and the signing domain. */
  v: StatementVersion;
  type: T;
  body: StatementBodies[T];
  signer: Ed25519PublicKey;
  alg: "ed25519";
  /** Unpadded base64url Ed25519 signature over the signing input. */
  sig: string;
};
