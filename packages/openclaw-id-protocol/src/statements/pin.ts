// Client pin and the per-session ServerBinding check (owner-key spec section 5, step 3).
import { fingerprint, type Ed25519PublicKey, type KeyFingerprint } from "../keys.js";
import type { ServerBindingBody, SignedStatement } from "./types.js";
import {
  failure,
  verifyOwnerStatement,
  type TrustAnchor,
  type VerifyFailure,
  type VerifyOptions,
} from "./verify.js";

/**
 * What a client stores per origin: {fp(R), claw_id, highest binding_seq seen}. A claw's
 * root never changes, so the pinned fingerprint is final. A fresh pin from an invite link
 * or kit has `claw_id: null` and `binding_seq: 0`.
 */
export type ClawPin = {
  claw_id: string | null;
  root_fp: KeyFingerprint;
  binding_seq: number;
};

/** Untrusted binding material, as served by Discovery in a descriptor. */
export type BindingEvidence = {
  /** The claw's root public key (checked against the pinned fingerprint). */
  root_pub: Ed25519PublicKey;
  binding: SignedStatement<"ServerBinding">;
};

/** Result of {@link verifyBindingForPin}. */
export type BindingCheck =
  | { ok: true; binding: ServerBindingBody; anchor: TrustAnchor; pin: ClawPin }
  | VerifyFailure;

/**
 * Verifies Discovery-served binding evidence against a pin before any socket opens:
 * the root is the pinned root (it never changes), the binding is signed by it,
 * binding_seq does not go backwards, the hostname is this origin's host and the claw id
 * matches. A replaced server key is retired by a higher binding_seq. Returns the pin to
 * store afterwards.
 */
export async function verifyBindingForPin(
  evidence: BindingEvidence,
  pin: ClawPin,
  context: Omit<VerifyOptions, "owners"> & { host: string },
): Promise<BindingCheck> {
  if ((await fingerprint(evidence.root_pub)) !== pin.root_fp) {
    return failure("root_mismatch", "descriptor root is not the pinned root");
  }
  const anchor: TrustAnchor = { root_pub: evidence.root_pub };
  const verified = await verifyOwnerStatement(evidence.binding, anchor, context);
  if (!verified.ok) {
    return verified;
  }
  const binding = evidence.binding.body;
  if (pin.claw_id !== null && binding.claw_id !== pin.claw_id) {
    return failure("wrong_claw", "binding is for another claw");
  }
  if (binding.hostname !== context.host) {
    return failure("host_mismatch", "binding hostname is not this origin");
  }
  if (binding.binding_seq < pin.binding_seq) {
    return failure("rollback", `binding_seq ${binding.binding_seq} < pinned ${pin.binding_seq}`);
  }
  return {
    ok: true,
    binding,
    anchor,
    pin: { claw_id: binding.claw_id, root_fp: pin.root_fp, binding_seq: binding.binding_seq },
  };
}
