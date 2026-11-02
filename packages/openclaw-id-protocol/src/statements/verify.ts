// Signature, chain and authority verification for signed statements.
import { fingerprint, type Ed25519PublicKey, type KeyFingerprint } from "../keys.js";
import { hasValidSignature } from "./envelope.js";
import {
  MAX_CHAIN_DEPTH,
  OWNER_CAPABILITIES,
  type OwnerCapability,
  type ServerBindingBody,
  type SignedStatement,
  type StatementType,
  type UnixSeconds,
} from "./types.js";

/** The pinned owner root a verifier trusts: R's public key and the current root epoch. */
export type TrustAnchor = { root_pub: Ed25519PublicKey; root_epoch: number };

/** Verifier inputs that are not part of the statement. */
export type VerifyOptions = {
  /** Current time, unix seconds. */
  now: UnixSeconds;
  /** Revocations the verifier knows about (by key fingerprint). */
  isRevoked?: (fp: KeyFingerprint) => boolean;
  /** Tolerated clock skew for `issued_at` in seconds. Default 300. */
  clockSkew?: number;
};

/** Who authorized a verified statement. Root supremacy: `root` overrides any `owner_device`. */
export type Authority =
  | { kind: "root" }
  | { kind: "owner_device"; device_pub: Ed25519PublicKey; caps: OwnerCapability[]; depth: number }
  | { kind: "gateway" }
  | { kind: "self" };

/** Stable verification failure codes. Callers match codes, never detail text. */
export type VerifyErrorCode =
  | "malformed"
  | "bad_signature"
  | "wrong_signer"
  | "chain_too_long"
  | "chain_broken"
  | "chain_expired"
  | "chain_revoked"
  | "wrong_epoch"
  | "missing_capability"
  | "not_yet_valid"
  | "root_mismatch"
  | "conflicting_rotation"
  | "wrong_claw"
  | "host_mismatch"
  | "rollback"
  | "server_key_revoked"
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

// Capability an owner device needs to sign each statement type (R needs none).
const REQUIRED_CAPABILITY: Record<OwnerSignedType, OwnerCapability | null> = {
  OwnerDeviceCert: "approve_device",
  ServerBinding: "bind",
  InviteCap: "invite",
  MembershipChange: "manage_members",
  Revocation: null,
};

function requiredCapability(statement: SignedStatement<OwnerSignedType>): OwnerCapability | null {
  if (
    statement.type === "MembershipChange" &&
    (statement as SignedStatement<"MembershipChange">).body.target.op === "add_owner_device"
  ) {
    return "approve_device";
  }
  return REQUIRED_CAPABILITY[statement.type];
}

function statementEpoch(statement: SignedStatement<OwnerSignedType>): number | null {
  const body = statement.body as { root_epoch?: number };
  return typeof body.root_epoch === "number" ? body.root_epoch : null;
}

/**
 * Walks an OwnerDeviceCert chain from R down to the statement's signer.
 *
 * chain[0] certifies the signer; chain[i] is signed by the key chain[i+1] certifies;
 * the last link is signed by R. Every link must verify, be in the anchor's epoch,
 * be unexpired and unrevoked; an issuing device needs `approve_device`, and a
 * link's caps never exceed its issuer's.
 */
async function resolveChain(
  statement: SignedStatement,
  anchor: TrustAnchor,
  options: VerifyOptions,
): Promise<Authority | VerifyFailure> {
  const { chain } = statement;
  if (chain.length === 0) {
    return failure("wrong_signer", "signer is not R and carries no certificate chain");
  }
  if (chain.length > MAX_CHAIN_DEPTH) {
    return failure("chain_too_long", `chain depth ${chain.length} > ${MAX_CHAIN_DEPTH}`);
  }
  const skew = options.clockSkew ?? 300;
  let issuer: Ed25519PublicKey = anchor.root_pub;
  let issuerCaps: readonly OwnerCapability[] = OWNER_CAPABILITIES;
  let issuerIsRoot = true;
  for (let index = chain.length - 1; index >= 0; index -= 1) {
    const link = chain[index];
    if (!link || link.type !== "OwnerDeviceCert" || link.chain.length !== 0) {
      return failure("chain_broken", `chain[${index}] is not a flat OwnerDeviceCert`);
    }
    if (link.signer !== issuer || !(await hasValidSignature(link))) {
      return failure("chain_broken", `chain[${index}] is not signed by its issuer`);
    }
    if (link.body.root_epoch !== anchor.root_epoch) {
      return failure("wrong_epoch", `chain[${index}] is from root epoch ${link.body.root_epoch}`);
    }
    if (link.body.issued_at > options.now + skew) {
      return failure("not_yet_valid", `chain[${index}] is issued in the future`);
    }
    if (link.body.expires_at !== null && link.body.expires_at <= options.now) {
      return failure("chain_expired", `chain[${index}] expired`);
    }
    if (options.isRevoked?.(await fingerprint(link.body.device_pub))) {
      return failure("chain_revoked", `chain[${index}] certifies a revoked device`);
    }
    if (!issuerIsRoot && !issuerCaps.includes("approve_device")) {
      return failure("missing_capability", `chain[${index}] issuer lacks approve_device`);
    }
    if (!link.body.caps.every((cap) => issuerCaps.includes(cap))) {
      return failure("missing_capability", `chain[${index}] grants more than its issuer holds`);
    }
    issuer = link.body.device_pub;
    issuerCaps = link.body.caps;
    issuerIsRoot = false;
  }
  if (issuer !== statement.signer) {
    return failure("chain_broken", "chain[0] does not certify the signer");
  }
  return { kind: "owner_device", device_pub: issuer, caps: [...issuerCaps], depth: chain.length };
}

/**
 * Verifies a statement that R or an owner device signs: signature, epoch, chain, and
 * the capability the statement type needs. An OwnerDeviceCert additionally may not
 * grant caps its signer lacks.
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
    if (statement.chain.length !== 0) {
      return failure("malformed", "a root-signed statement carries no chain");
    }
    return { ok: true, statement, authority: { kind: "root" } };
  }
  const authority = await resolveChain(statement, anchor, options);
  if ("ok" in authority) {
    return authority;
  }
  if (authority.kind !== "owner_device") {
    return failure("wrong_signer", "unexpected authority");
  }
  const needed = requiredCapability(statement);
  if (needed !== null && !authority.caps.includes(needed)) {
    return failure("missing_capability", `signer lacks ${needed}`);
  }
  if (statement.type === "OwnerDeviceCert") {
    const caps = (statement as SignedStatement<"OwnerDeviceCert">).body.caps;
    if (!caps.every((cap) => authority.caps.includes(cap))) {
      return failure("missing_capability", "certificate grants more than its signer holds");
    }
    if (authority.depth >= MAX_CHAIN_DEPTH) {
      return failure("chain_too_long", "certificate would exceed the maximum chain depth");
    }
  }
  return { ok: true, statement, authority };
}

/** Verifies a RootRotation against the current anchor and returns the next anchor. */
export async function verifyRootRotation(
  statement: SignedStatement<"RootRotation">,
  anchor: TrustAnchor,
): Promise<{ ok: true; anchor: TrustAnchor } | VerifyFailure> {
  if (statement.signer !== anchor.root_pub || statement.chain.length !== 0) {
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
  if (statement.signer !== binding.k_gw || statement.chain.length !== 0) {
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
  if (statement.signer !== statement.body.device_pub || statement.chain.length !== 0) {
    return failure("wrong_signer", "redemption must be signed by its own device key");
  }
  if (!(await hasValidSignature(statement))) {
    return failure("bad_signature", "envelope signature does not verify");
  }
  return { ok: true, statement, authority: { kind: "self" } };
}
