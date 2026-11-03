// Signature and authority verification for signed statements.
import { fingerprint, type Ed25519PublicKey } from "../keys.js";
import { hasValidSignature } from "./envelope.js";
import type {
  OwnerCapability,
  ServerBindingBody,
  SignedStatement,
  StatementType,
  UnixSeconds,
} from "./types.js";

/** The pinned owner root a verifier trusts: R's public key and the current root epoch. */
export type TrustAnchor = { root_pub: Ed25519PublicKey; root_epoch: number };

/**
 * The claw's current owner devices, as only its Gateway knows them: the capabilities of
 * `devicePub` while it is an active owner device there, otherwise undefined.
 */
export type OwnerDeviceLookup = (devicePub: Ed25519PublicKey) => OwnerCapability[] | undefined;

/** Verifier inputs that are not part of the statement. */
export type VerifyOptions = {
  /** Current time, unix seconds. */
  now: UnixSeconds;
  /** The claw's current owner devices. Without it, only R's signatures verify. */
  owners?: OwnerDeviceLookup;
  /** Tolerated clock skew for `issued_at` in seconds. Default 300. */
  clockSkew?: number;
};

/** Who authorized a verified statement. Root supremacy: `root` overrides any `owner_device`. */
export type Authority =
  | { kind: "root" }
  | { kind: "owner_device"; device_pub: Ed25519PublicKey; caps: OwnerCapability[] }
  | { kind: "gateway" }
  | { kind: "self" };

/** Stable verification failure codes. Callers match codes, never detail text. */
export type VerifyErrorCode =
  | "malformed"
  | "bad_signature"
  | "wrong_signer"
  | "not_an_owner"
  | "wrong_epoch"
  | "missing_capability"
  | "caps_escalation"
  | "not_yet_valid"
  | "root_mismatch"
  | "conflicting_rotation"
  | "wrong_claw"
  | "host_mismatch"
  | "rollback"
  | "bad_proof"
  | "expired"
  | "audience_mismatch";

/** A verification failure. */
export type VerifyFailure = { ok: false; code: VerifyErrorCode; detail: string };

/** Result of verifying a statement. */
export type VerifyResult<T extends StatementType> =
  | { ok: true; statement: SignedStatement<T>; authority: Authority }
  | VerifyFailure;

/** Builds a failure result. */
export function failure(code: VerifyErrorCode, detail: string): VerifyFailure {
  return { ok: false, code, detail };
}

/** Statement types whose signer is R or an owner device. */
export type OwnerSignedType =
  | "OwnerDeviceCert"
  | "ServerBinding"
  | "InviteCap"
  | "MembershipChange"
  | "Revocation";

// Capability an owner device needs to sign each statement type (R needs none). A
// ServerBinding is R's alone: clients that pin only fp(R) must be able to check it.
const REQUIRED_CAPABILITY: Record<
  Exclude<OwnerSignedType, "ServerBinding">,
  OwnerCapability | null
> = {
  OwnerDeviceCert: "approve_device",
  InviteCap: "invite",
  MembershipChange: "manage_members",
  Revocation: null,
};

function requiredCapability(
  statement: SignedStatement<Exclude<OwnerSignedType, "ServerBinding">>,
): OwnerCapability | null {
  if (
    statement.type === "MembershipChange" &&
    // SAFETY: SignedStatement is not a discriminated union; `type` fixes the body.
    (statement as SignedStatement<"MembershipChange">).body.target.op === "add_owner_device"
  ) {
    return "approve_device";
  }
  return REQUIRED_CAPABILITY[statement.type];
}

function statementEpoch(statement: SignedStatement<OwnerSignedType>): number | null {
  // SAFETY: every owner-signed body type either has a numeric root_epoch or none.
  const body = statement.body as { root_epoch?: number };
  return typeof body.root_epoch === "number" ? body.root_epoch : null;
}

/**
 * Verifies a statement that R or an owner device signs: signature, epoch, and authority.
 * R may sign anything. An owner device must be one of the claw's current owner devices
 * (`options.owners`) holding the capability the statement type needs; an OwnerDeviceCert it
 * signs may not grant caps it lacks. A ServerBinding verifies only when R signed it.
 */
export async function verifyOwnerStatement<T extends OwnerSignedType>(
  statement: SignedStatement<T>,
  anchor: TrustAnchor,
  options: VerifyOptions,
): Promise<VerifyResult<T>> {
  if (!(await hasValidSignature(statement))) {
    return failure("bad_signature", "envelope signature does not verify");
  }
  const epoch = statementEpoch(statement);
  if (epoch !== null && epoch !== anchor.root_epoch) {
    return failure(
      "wrong_epoch",
      `statement is from root epoch ${epoch}, pinned epoch is ${anchor.root_epoch}`,
    );
  }
  if (statement.signer === anchor.root_pub) {
    return { ok: true, statement, authority: { kind: "root" } };
  }
  if (statement.type === "ServerBinding") {
    return failure("wrong_signer", "a server binding must be signed by R");
  }
  const caps = options.owners?.(statement.signer);
  if (!caps) {
    return failure("not_an_owner", "signer is neither R nor a current owner device of this claw");
  }
  // SAFETY: the ServerBinding member of the union returned above.
  const owned = statement as SignedStatement<Exclude<OwnerSignedType, "ServerBinding">>;
  const needed = requiredCapability(owned);
  if (needed !== null && !caps.includes(needed)) {
    return failure("missing_capability", `signer lacks ${needed}`);
  }
  if (statement.type === "OwnerDeviceCert") {
    // SAFETY: SignedStatement is not a discriminated union; `type` fixes the body.
    const granted = (statement as SignedStatement<"OwnerDeviceCert">).body.caps;
    if (!granted.every((cap) => caps.includes(cap))) {
      return failure("caps_escalation", "certificate grants capabilities its signer does not hold");
    }
  }
  return {
    ok: true,
    statement,
    authority: { kind: "owner_device", device_pub: statement.signer, caps: [...caps] },
  };
}

/** Verifies a RootRotation against the current anchor and returns the next anchor. */
export async function verifyRootRotation(
  statement: SignedStatement<"RootRotation">,
  anchor: TrustAnchor,
): Promise<{ ok: true; anchor: TrustAnchor } | VerifyFailure> {
  if (statement.signer !== anchor.root_pub) {
    return failure("wrong_signer", "a root rotation must be signed by the current R alone");
  }
  if (!(await hasValidSignature(statement))) {
    return failure("bad_signature", "envelope signature does not verify");
  }
  if (statement.body.old_root_fp !== (await fingerprint(anchor.root_pub))) {
    return failure("root_mismatch", "old_root_fp is not the current root");
  }
  if (statement.body.new_epoch !== anchor.root_epoch + 1) {
    return failure("wrong_epoch", "new_epoch must be the current epoch + 1");
  }
  return {
    ok: true,
    anchor: { root_pub: statement.body.new_root_pub, root_epoch: statement.body.new_epoch },
  };
}

/** Verifies a Gateway-signed membership snapshot against the claw's verified ServerBinding (K_gw). */
export async function verifyMembershipSnapshot(
  statement: SignedStatement<"MembershipSnapshot">,
  binding: ServerBindingBody,
): Promise<VerifyResult<"MembershipSnapshot">> {
  if (statement.signer !== binding.k_gw) {
    return failure("wrong_signer", "snapshot is not signed by the binding's K_gw");
  }
  if (!(await hasValidSignature(statement))) {
    return failure("bad_signature", "envelope signature does not verify");
  }
  if (statement.body.claw_id !== binding.claw_id) {
    return failure("wrong_claw", "snapshot is for another claw");
  }
  return { ok: true, statement, authority: { kind: "gateway" } };
}

/** Verifies that an InviteRedemption is self-signed by the device key it names. The proof is checked in invites.ts. */
export async function verifyInviteRedemptionSignature(
  statement: SignedStatement<"InviteRedemption">,
): Promise<VerifyResult<"InviteRedemption">> {
  if (statement.signer !== statement.body.device_pub) {
    return failure("wrong_signer", "redemption must be signed by its own device key");
  }
  if (!(await hasValidSignature(statement))) {
    return failure("bad_signature", "envelope signature does not verify");
  }
  return { ok: true, statement, authority: { kind: "self" } };
}
