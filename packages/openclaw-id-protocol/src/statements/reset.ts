// Owner reset (OCF-319): a root change the claw's Gateway key vouches for.
import type { Ed25519PublicKey } from "../keys.js";
import type { RootResetBody, SignedStatement } from "./types.js";
import {
  failure,
  verifyOwnerStatement,
  verifyRootResetSignature,
  type VerifyFailure,
  type VerifyOptions,
} from "./verify.js";

/** A root public key and a ServerBinding that root signed. */
export type RootBinding = {
  root_pub: Ed25519PublicKey;
  binding: SignedStatement<"ServerBinding">;
};

/**
 * What a descriptor carries after an owner reset: the binding the reset replaced (signed by the
 * previous root) and the K_gw-signed RootReset. A client pinned to the previous root checks the
 * previous binding against its pin, then the reset against that binding's K_gw.
 */
export type RootResetEvidence = {
  previous_root_pub: Ed25519PublicKey;
  previous_binding: SignedStatement<"ServerBinding">;
  statement: SignedStatement<"RootReset">;
};

/** Result of {@link verifyRootReset}. */
export type RootResetCheck = { ok: true; reset: RootResetBody } | VerifyFailure;

/**
 * Verifies that `next` legitimately replaces `current` by an owner reset. `current` must already
 * be trusted by the caller (Discovery's stored descriptor, or a binding the client verified
 * against its pin). Checks, in order: the RootReset is signed by current's K_gw for the same claw
 * (`wrong_signer`, `bad_signature`, `wrong_claw`); its binding_seq is higher than current's
 * (`rollback`); it names next's root (`root_mismatch`), which is a new root (`reset_mismatch`);
 * next's binding is signed by that root (`wrong_signer`, `bad_signature`) and keeps the claw,
 * hostname, K_srv and K_gw at the reset's binding_seq (`wrong_claw`, `host_mismatch`,
 * `reset_mismatch`).
 */
export async function verifyRootReset(
  current: RootBinding,
  reset: SignedStatement<"RootReset">,
  next: RootBinding,
  options: Pick<VerifyOptions, "now">,
): Promise<RootResetCheck> {
  const before = current.binding.body;
  const signed = await verifyRootResetSignature(reset, before);
  if (!signed.ok) {
    return signed;
  }
  const body = reset.body;
  if (body.binding_seq <= before.binding_seq) {
    return failure("rollback", `reset binding_seq ${body.binding_seq} <= ${before.binding_seq}`);
  }
  if (body.new_root_pub !== next.root_pub) {
    return failure("root_mismatch", "the reset names another root");
  }
  if (next.root_pub === current.root_pub) {
    return failure("reset_mismatch", "a reset must replace the root");
  }
  const verified = await verifyOwnerStatement(
    next.binding,
    { root_pub: next.root_pub },
    { now: options.now },
  );
  if (!verified.ok) {
    return verified;
  }
  const after = next.binding.body;
  if (after.claw_id !== before.claw_id) {
    return failure("wrong_claw", "the new binding is for another claw");
  }
  if (after.hostname !== before.hostname) {
    return failure("host_mismatch", "a reset keeps the hostname");
  }
  if (after.k_srv !== before.k_srv || after.k_gw !== before.k_gw) {
    return failure("reset_mismatch", "a reset keeps K_srv and K_gw");
  }
  if (after.binding_seq !== body.binding_seq) {
    return failure("reset_mismatch", "the new binding is not the one the reset names");
  }
  return { ok: true, reset: body };
}
