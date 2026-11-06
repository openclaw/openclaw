// ClawDescriptor: what the Gateway publishes and Discovery serves. Untrusted for clients.

import { canonicalize } from "../jcs.js";
import type { Ed25519PublicKey } from "../keys.js";
import { isClawId, isEd25519PublicKey } from "../keys.js";
import type { BindingEvidence } from "../statements/pin.js";
import {
  verifyRootReset,
  type RootResetCheck,
  type RootResetEvidence,
} from "../statements/reset.js";
import type { SignedStatement, UnixSeconds } from "../statements/types.js";
import { parseStatement } from "../statements/validate.js";
import {
  failure,
  verifyOwnerStatement,
  type VerifyOptions,
  type VerifyResult,
} from "../statements/verify.js";
import { checkVersion, SUPPORTED_DESCRIPTOR_VERSIONS, type DescriptorVersion } from "../version.js";

/**
 * Published by the Gateway, stored and served by Discovery. Clients verify it with
 * `verifyBindingForPin(descriptorEvidence(descriptor), pin, ...)` before dialing;
 * nothing in it is trusted because Discovery served it.
 */
export type ClawDescriptor = {
  /** Descriptor version. v1 is the stable bootstrap every client reads (docs/versioning.md). */
  v: DescriptorVersion;
  claw_id: string;
  transport: "iroh";
  /** Untrusted routing hint: the relay K_srv is homed on. */
  relay_url: string;
  /** The claw's owner root public key (clients check it against their pinned fingerprint). */
  root_pub: Ed25519PublicKey;
  /** Current ServerBinding, signed by R. */
  binding: SignedStatement<"ServerBinding">;
  /**
   * Only after an owner reset, and only with the binding the reset created: the previous root
   * and binding and the K_gw-signed RootReset. Absent otherwise (docs/discovery.md, "Owner reset").
   */
  reset?: RootResetEvidence;
  published_at: UnixSeconds;
};

/**
 * Result of {@link parseClawDescriptor}. `unsupported_version` is a well-formed descriptor (or
 * binding envelope) version this build does not implement: the client needs an update.
 */
export type DescriptorParse =
  | { ok: true; descriptor: ClawDescriptor }
  | { ok: false; code: "malformed" | "unsupported_version"; detail: string };

function malformed(detail: string): DescriptorParse {
  return { ok: false, code: "malformed", detail };
}

const DESCRIPTOR_FIELDS = new Set([
  "v",
  "claw_id",
  "transport",
  "relay_url",
  "root_pub",
  "binding",
  "reset",
  "published_at",
]);

const RESET_FIELDS = ["previous_root_pub", "previous_binding", "statement"];

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
    return malformed("descriptor must be an object");
  }
  // SAFETY: the guard above rejected non-objects, null and arrays.
  const record = value as Record<string, unknown>;
  // The version comes first: a later version may add fields this build does not know.
  const version = checkVersion(record.v, SUPPORTED_DESCRIPTOR_VERSIONS);
  if (version.kind === "unsupported") {
    return {
      ok: false,
      code: "unsupported_version",
      detail: `descriptor version ${version.version} is not supported`,
    };
  }
  if (version.kind === "malformed") {
    return malformed("expected descriptor version");
  }
  const unknown = Object.keys(record).find((key) => !DESCRIPTOR_FIELDS.has(key));
  if (unknown !== undefined) {
    return malformed(`unknown field ${unknown}`);
  }
  if (record.transport !== "iroh") {
    return malformed("expected transport iroh");
  }
  if (
    !isClawId(record.claw_id) ||
    !isEd25519PublicKey(record.root_pub) ||
    !isRelayUrl(record.relay_url)
  ) {
    return malformed("invalid claw_id, root_pub or relay_url");
  }
  if (
    typeof record.published_at !== "number" ||
    !Number.isSafeInteger(record.published_at) ||
    record.published_at < 0
  ) {
    return malformed("invalid published_at");
  }
  const binding = parseStatement(record.binding, "ServerBinding");
  if (!binding.ok) {
    return { ok: false, code: binding.code, detail: `binding: ${binding.detail}` };
  }
  if (binding.statement.body.claw_id !== record.claw_id) {
    return malformed("binding is for another claw");
  }
  if (record.reset !== undefined) {
    const reset = parseResetEvidence(record.reset);
    if (reset) {
      return reset;
    }
  }
  // SAFETY: every ClawDescriptor field was validated above and unknown fields were rejected.
  return { ok: true, descriptor: value as ClawDescriptor };
}

// Shape of the reset evidence; null when valid. Whether it is consistent is for verifyRootReset,
// so a forged reset fails on its signature or keys, never here.
function parseResetEvidence(value: unknown): DescriptorParse | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return malformed("reset must be an object");
  }
  // SAFETY: the guard above rejected non-objects, null and arrays.
  const reset = value as Record<string, unknown>;
  const keys = Object.keys(reset);
  if (keys.length !== RESET_FIELDS.length || !RESET_FIELDS.every((key) => keys.includes(key))) {
    return malformed(`reset must have exactly ${RESET_FIELDS.join(", ")}`);
  }
  if (!isEd25519PublicKey(reset.previous_root_pub)) {
    return malformed("invalid reset.previous_root_pub");
  }
  const previous = parseStatement(reset.previous_binding, "ServerBinding");
  if (!previous.ok) {
    return { ok: false, code: previous.code, detail: `reset.previous_binding: ${previous.detail}` };
  }
  const statement = parseStatement(reset.statement, "RootReset");
  if (!statement.ok) {
    return { ok: false, code: statement.code, detail: `reset.statement: ${statement.detail}` };
  }
  return null;
}

/** The untrusted binding material a client feeds into `verifyBindingForPin`. */
export function descriptorEvidence(descriptor: ClawDescriptor): BindingEvidence {
  return {
    root_pub: descriptor.root_pub,
    binding: descriptor.binding,
    ...(descriptor.reset ? { reset: descriptor.reset } : {}),
  };
}

/**
 * Discovery-side consistency check on publish: the binding verifies under the descriptor's own
 * root, and reset evidence, if present, is a valid reset from its previous binding to this one.
 * This catches Gateway bugs early; it is not a security check (Discovery pins nothing) and
 * clients verify again against their pin.
 */
export async function checkDescriptorConsistency(
  descriptor: ClawDescriptor,
  options: VerifyOptions,
): Promise<VerifyResult<"ServerBinding">> {
  const verified = await verifyOwnerStatement(
    descriptor.binding,
    { root_pub: descriptor.root_pub },
    options,
  );
  if (!verified.ok || !descriptor.reset) {
    return verified;
  }
  const reset = descriptor.reset;
  const previous = { root_pub: reset.previous_root_pub, binding: reset.previous_binding };
  const before = await verifyOwnerStatement(
    previous.binding,
    { root_pub: previous.root_pub },
    options,
  );
  if (!before.ok) {
    return before;
  }
  const checked = await verifyRootReset(previous, reset.statement, descriptor, options);
  return checked.ok ? verified : checked;
}

/**
 * Discovery's check for a republished descriptor whose root differs from the stored one. It is
 * accepted only as an owner reset from the stored descriptor: the reset evidence names the stored
 * root and binding (else `reset_mismatch`; none at all is `root_mismatch`), and
 * `verifyRootReset` passes with the stored binding as the current one, so the RootReset is signed
 * by the K_gw Discovery already holds for this claw.
 */
export async function checkDescriptorRootReset(
  stored: ClawDescriptor,
  next: ClawDescriptor,
  options: Pick<VerifyOptions, "now">,
): Promise<RootResetCheck> {
  const reset = next.reset;
  if (!reset) {
    return failure("root_mismatch", "a new root needs a root reset");
  }
  if (
    reset.previous_root_pub !== stored.root_pub ||
    canonicalize(reset.previous_binding) !== canonicalize(stored.binding)
  ) {
    return failure("reset_mismatch", "the reset does not continue the published binding");
  }
  return verifyRootReset(
    { root_pub: stored.root_pub, binding: stored.binding },
    reset.statement,
    next,
    options,
  );
}
