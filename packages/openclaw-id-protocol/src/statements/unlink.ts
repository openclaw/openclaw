// Unlinking a claw (OCF-281): a ClawUnlink signed by the K_gw of the claw's current binding.
import { hasValidSignature } from "./envelope.js";
import type { ClawPin } from "./pin.js";
import type { ClawUnlinkBody, ServerBindingBody, SignedStatement } from "./types.js";
import { failure, type VerifyFailure } from "./verify.js";

/** Result of {@link verifyClawUnlink} and {@link verifyClawUnlinkForPin}. */
export type ClawUnlinkCheck = { ok: true; unlink: ClawUnlinkBody } | VerifyFailure;

/**
 * Verifies a ClawUnlink against the claw's current binding, as Discovery stores it. Checks, in
 * order: signed by the binding's K_gw (`wrong_signer`, `bad_signature`); for the same claw
 * (`wrong_claw`); for exactly the current binding_seq: lower is a replay or an older key
 * (`rollback`), higher names a binding that was never published (`not_yet_valid`).
 */
export async function verifyClawUnlink(
  statement: SignedStatement<"ClawUnlink">,
  binding: ServerBindingBody,
): Promise<ClawUnlinkCheck> {
  if (statement.signer !== binding.k_gw) {
    return failure("wrong_signer", "unlink is not signed by the current binding's K_gw");
  }
  if (!(await hasValidSignature(statement))) {
    return failure("bad_signature", "envelope signature does not verify");
  }
  const body = statement.body;
  if (body.claw_id !== binding.claw_id) {
    return failure("wrong_claw", "unlink is for another claw");
  }
  if (body.binding_seq < binding.binding_seq) {
    return failure(
      "rollback",
      `unlink binding_seq ${body.binding_seq} < current ${binding.binding_seq}`,
    );
  }
  if (body.binding_seq > binding.binding_seq) {
    return failure(
      "not_yet_valid",
      `unlink binding_seq ${body.binding_seq} > current ${binding.binding_seq}`,
    );
  }
  return { ok: true, unlink: body };
}

/**
 * Verifies a ClawUnlink that Discovery serves with an `unlinked` error against a client pin:
 * signed by the K_gw the pin stored (`wrong_signer`, also for a pin without `k_gw`;
 * `bad_signature`), for the pinned claw (`wrong_claw`, also for a pin without `claw_id`), and not
 * for a binding older than the pin has seen (`rollback`). Only a verified unlink clears the pin.
 */
export async function verifyClawUnlinkForPin(
  statement: SignedStatement<"ClawUnlink">,
  pin: ClawPin,
): Promise<ClawUnlinkCheck> {
  if (pin.k_gw === undefined || statement.signer !== pin.k_gw) {
    return failure("wrong_signer", "unlink is not signed by the pinned K_gw");
  }
  if (!(await hasValidSignature(statement))) {
    return failure("bad_signature", "envelope signature does not verify");
  }
  const body = statement.body;
  if (pin.claw_id === null || body.claw_id !== pin.claw_id) {
    return failure("wrong_claw", "unlink is not for the pinned claw");
  }
  if (body.binding_seq < pin.binding_seq) {
    return failure(
      "rollback",
      `unlink binding_seq ${body.binding_seq} < pinned ${pin.binding_seq}`,
    );
  }
  return { ok: true, unlink: body };
}
