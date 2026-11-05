// Client pin and the per-session ServerBinding check (owner-key spec section 5, step 3).
import { fingerprint, type KeyFingerprint } from "../keys.js";
import { verifyRootReset, type RootBinding, type RootResetEvidence } from "./reset.js";
import type { ServerBindingBody } from "./types.js";
import {
  failure,
  verifyOwnerStatement,
  type TrustAnchor,
  type VerifyFailure,
  type VerifyOptions,
} from "./verify.js";

/**
 * What a client stores per origin: {fp(R), claw_id, highest binding_seq seen}. Only an owner
 * reset replaces the root, and then the client sets up a new pin from the new kit; it never
 * moves this one. A fresh pin from an invite link or kit has `claw_id: null` and `binding_seq: 0`.
 */
export type ClawPin = {
  claw_id: string | null;
  root_fp: KeyFingerprint;
  binding_seq: number;
};

/** Untrusted binding material, as served by Discovery in a descriptor. */
export type BindingEvidence = RootBinding & {
  /** Present after an owner reset: how the root of `binding` replaced the previous one. */
  reset?: RootResetEvidence;
};

/** Result of {@link verifyBindingForPin}. */
export type BindingCheck =
  | { ok: true; binding: ServerBindingBody; anchor: TrustAnchor; pin: ClawPin }
  | VerifyFailure;

type PinContext = Omit<VerifyOptions, "owners"> & { host: string };

/**
 * Verifies Discovery-served binding evidence against a pin before any socket opens:
 * the root is the pinned root, the binding is signed by it, binding_seq does not go backwards,
 * the hostname is this origin's host and the claw id matches. A replaced server key is retired
 * by a higher binding_seq. Returns the pin to store afterwards.
 *
 * A different root fails with `root_mismatch` (substitution), except after an owner reset the
 * pinned claw vouched for: the evidence's previous binding passes these same checks under the
 * pinned root and its K_gw signed a valid RootReset to the served root (`verifyRootReset`). That
 * fails with `owner_reset`: nothing is dialed and no pin is returned; the browser must be set up
 * again with the new kit.
 */
export async function verifyBindingForPin(
  evidence: BindingEvidence,
  pin: ClawPin,
  context: PinContext,
): Promise<BindingCheck> {
  if ((await fingerprint(evidence.root_pub)) === pin.root_fp) {
    return verifyUnderPin(evidence, pin, context);
  }
  const reset = evidence.reset;
  if (!reset) {
    return failure("root_mismatch", "descriptor root is not the pinned root");
  }
  const previous = { root_pub: reset.previous_root_pub, binding: reset.previous_binding };
  if ((await fingerprint(previous.root_pub)) !== pin.root_fp) {
    return failure("root_mismatch", "root reset does not start at the pinned root");
  }
  const before = await verifyUnderPin(previous, pin, context);
  if (!before.ok) {
    return failure("root_mismatch", `root reset predecessor: ${before.code}`);
  }
  const checked = await verifyRootReset(previous, reset.statement, evidence, context);
  if (!checked.ok) {
    return failure("root_mismatch", `root reset: ${checked.code}`);
  }
  return failure("owner_reset", "the owner reset access to this claw");
}

// The pin checks for a binding under the pinned root.
async function verifyUnderPin(
  evidence: RootBinding,
  pin: ClawPin,
  context: PinContext,
): Promise<BindingCheck> {
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
