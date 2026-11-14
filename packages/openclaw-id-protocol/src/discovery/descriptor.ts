// ClawDescriptor: what the Gateway publishes and Discovery serves. Untrusted for clients.
import type { Ed25519PublicKey } from "../keys.js";
import { isClawId, isEd25519PublicKey } from "../keys.js";
import type { BindingEvidence } from "../statements/pin.js";
import type { SignedStatement, UnixSeconds } from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import {
  verifyOwnerStatement,
  type VerifyOptions,
  type VerifyResult,
} from "../statements/verify.js";

/**
 * Published by the Gateway, stored and served by Discovery. Clients verify it with
 * `verifyBindingForPin(descriptorEvidence(descriptor), pin, ...)` before dialing;
 * nothing in it is trusted because Discovery served it.
 */
export type ClawDescriptor = {
  v: 1;
  claw_id: string;
  transport: "iroh";
  /** Untrusted routing hint: the relay K_srv is homed on. */
  relay_url: string;
  /** The claw's owner root public key (clients check it against their pinned fingerprint). */
  root_pub: Ed25519PublicKey;
  /** Current ServerBinding, signed by R. */
  binding: SignedStatement<"ServerBinding">;
  published_at: UnixSeconds;
};

/** Result of {@link parseClawDescriptor}. */
export type DescriptorParse =
  | { ok: true; descriptor: ClawDescriptor }
  | { ok: false; detail: string };

const DESCRIPTOR_FIELDS = new Set([
  "v",
  "claw_id",
  "transport",
  "relay_url",
  "root_pub",
  "binding",
  "published_at",
]);

function isRelayUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > 512) {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" ||
      (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
    );
  } catch {
    return false;
  }
}

/** Validates the shape of an untrusted descriptor (statements included). Does not verify signatures. */
export function parseClawDescriptor(value: unknown): DescriptorParse {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, detail: "descriptor must be an object" };
  }
  // SAFETY: the guard above rejected non-objects, null and arrays.
  const record = value as Record<string, unknown>;
  const unknown = Object.keys(record).find((key) => !DESCRIPTOR_FIELDS.has(key));
  if (unknown !== undefined) {
    return { ok: false, detail: `unknown field ${unknown}` };
  }
  if (record.v !== 1 || record.transport !== "iroh") {
    return { ok: false, detail: "expected v 1 and transport iroh" };
  }
  if (
    !isClawId(record.claw_id) ||
    !isEd25519PublicKey(record.root_pub) ||
    !isRelayUrl(record.relay_url)
  ) {
    return { ok: false, detail: "invalid claw_id, root_pub or relay_url" };
  }
  if (
    typeof record.published_at !== "number" ||
    !Number.isSafeInteger(record.published_at) ||
    record.published_at < 0
  ) {
    return { ok: false, detail: "invalid published_at" };
  }
  const binding = parseStatement(record.binding, "ServerBinding");
  if (!binding.ok) {
    return { ok: false, detail: `binding: ${binding.detail}` };
  }
  if (binding.statement.body.claw_id !== record.claw_id) {
    return { ok: false, detail: "binding is for another claw" };
  }
  // SAFETY: every ClawDescriptor field was validated above and unknown fields were rejected.
  return { ok: true, descriptor: value as ClawDescriptor };
}

/** The untrusted binding material a client feeds into `verifyBindingForPin`. */
export function descriptorEvidence(descriptor: ClawDescriptor): BindingEvidence {
  return {
    root_pub: descriptor.root_pub,
    binding: descriptor.binding,
  };
}

/**
 * Discovery-side consistency check on publish: the binding verifies under the
 * descriptor's own root. This catches Gateway bugs early; it is
 * not a security check (Discovery pins nothing) and clients verify again against their pin.
 */
export async function checkDescriptorConsistency(
  descriptor: ClawDescriptor,
  options: VerifyOptions,
): Promise<VerifyResult<"ServerBinding">> {
  return verifyOwnerStatement(descriptor.binding, { root_pub: descriptor.root_pub }, options);
}
