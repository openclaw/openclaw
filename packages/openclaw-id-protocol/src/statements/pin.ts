// Client pin and the per-session ServerBinding check (owner-key spec section 5, step 3).
import { fingerprint, type Ed25519PublicKey, type KeyFingerprint } from "../keys.js";
import type { ServerBindingBody, SignedStatement } from "./types.js";
import {
  failure,
  verifyOwnerStatement,
  verifyRootRotation,
  type TrustAnchor,
  type VerifyFailure,
  type VerifyOptions,
} from "./verify.js";

/**
 * What a client stores per origin: {fp(R), claw_id, highest binding_seq seen, root_epoch}.
 * A fresh pin from an invite link or kit has `claw_id: null`, `binding_seq: 0` and
 * `root_epoch: 0` (unknown).
 */
export type ClawPin = {
  claw_id: string | null;
  root_fp: KeyFingerprint;
  root_epoch: number;
  binding_seq: number;
};

/** Untrusted binding material, as served by Discovery in a descriptor. */
export type BindingEvidence = {
  /** Current root public key (checked against the pinned fingerprint, possibly via rotations). */
  root_pub: Ed25519PublicKey;
  /** Root rotations, oldest first. Only those after the pinned epoch matter. */
  rotations: SignedStatement<"RootRotation">[];
  binding: SignedStatement<"ServerBinding">;
};

/** Result of {@link verifyBindingForPin}. */
export type BindingCheck =
  | { ok: true; binding: ServerBindingBody; anchor: TrustAnchor; pin: ClawPin }
  | VerifyFailure;

// Follows rotations from the pinned root to the newest one. Two different rotations out
// of the same epoch are a conflict (spec section 8.3) and fail closed.
async function followRotations(
  pin: ClawPin,
  rotations: SignedStatement<"RootRotation">[],
): Promise<
  { ok: true; fp: KeyFingerprint; epoch: number; root_pub: Ed25519PublicKey | null } | VerifyFailure
> {
  const seen = new Map<string, string>();
  for (const rotation of rotations) {
    const key = `${rotation.body.old_root_fp}/${rotation.body.new_epoch}`;
    const previous = seen.get(key);
    if (previous !== undefined && previous !== rotation.sig) {
      return failure("conflicting_rotation", `two rotations out of ${key}`);
    }
    seen.set(key, rotation.sig);
  }
  let fp = pin.root_fp;
  let epoch = pin.root_epoch;
  let rootPub: Ed25519PublicKey | null = null;
  for (;;) {
    const next = rotations.find(
      (rotation) =>
        rotation.body.old_root_fp === fp && (epoch === 0 || rotation.body.new_epoch === epoch + 1),
    );
    if (!next) {
      return { ok: true, fp, epoch, root_pub: rootPub };
    }
    const step = await verifyRootRotation(next, {
      root_pub: next.signer,
      root_epoch: next.body.new_epoch - 1,
    });
    if (!step.ok) {
      return step;
    }
    fp = await fingerprint(step.anchor.root_pub);
    epoch = step.anchor.root_epoch;
    rootPub = step.anchor.root_pub;
  }
}

/**
 * Verifies Discovery-served binding evidence against a pin before any socket opens:
 * the binding chains to the pinned R (through verified rotations), root_epoch and
 * binding_seq do not go backwards, the hostname is this origin's host, the claw id
 * matches, and K_srv is not revoked. Returns the pin to store afterwards.
 */
export async function verifyBindingForPin(
  evidence: BindingEvidence,
  pin: ClawPin,
  context: VerifyOptions & { host: string },
): Promise<BindingCheck> {
  const walked = await followRotations(pin, evidence.rotations);
  if (!walked.ok) {
    return walked;
  }
  if ((await fingerprint(evidence.root_pub)) !== walked.fp) {
    return failure("root_mismatch", "descriptor root is not the pinned root");
  }
  const binding = evidence.binding.body;
  const epoch = walked.epoch === 0 ? binding.root_epoch : walked.epoch;
  if (epoch < pin.root_epoch) {
    return failure("rollback", "root epoch went backwards");
  }
  const anchor: TrustAnchor = { root_pub: evidence.root_pub, root_epoch: epoch };
  const verified = await verifyOwnerStatement(evidence.binding, anchor, context);
  if (!verified.ok) {
    return verified;
  }
  if (pin.claw_id !== null && binding.claw_id !== pin.claw_id) {
    return failure("wrong_claw", "binding is for another claw");
  }
  if (binding.hostname !== context.host) {
    return failure("host_mismatch", "binding hostname is not this origin");
  }
  if (binding.binding_seq < pin.binding_seq) {
    return failure("rollback", `binding_seq ${binding.binding_seq} < pinned ${pin.binding_seq}`);
  }
  if (context.isRevoked?.(await fingerprint(binding.k_srv))) {
    return failure("server_key_revoked", "K_srv is revoked");
  }
  return {
    ok: true,
    binding,
    anchor,
    pin: {
      claw_id: binding.claw_id,
      root_fp: walked.fp,
      root_epoch: epoch,
      binding_seq: binding.binding_seq,
    },
  };
}
