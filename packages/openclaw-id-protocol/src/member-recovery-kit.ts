// Offline member device key and its claw pin; never an owner recovery credential.
import { ed25519SignerFromSeed, hkdfSha256, type StatementSigner } from "./crypto.js";
import { isKeyFingerprint, isRandomId, type KeyFingerprint } from "./keys.js";
import { decodeKit, encodeKit, generateKitSecret } from "./kit.js";

export type MemberRecoveryKit = {
  kind: "openclaw-member-recovery-kit";
  claw_id: string;
  account_id: string;
  hostname: string;
  root_fp: KeyFingerprint;
  code: string;
};

/** Domain-separated member key; the same secret never yields the owner root key. */
export async function deriveMemberRecoverySigner(secret: Uint8Array): Promise<StatementSigner> {
  if (secret.length !== 16) {
    throw new Error("member kit secret must be 16 bytes");
  }
  const seed = await hkdfSha256(secret, "openclaw/member-recovery/v1", "ed25519-seed", 32);
  try {
    return await ed25519SignerFromSeed(seed);
  } finally {
    seed.fill(0);
  }
}

/** Creates an export plus the public-key ceremony signer. Callers discard both after saving. */
export async function createMemberRecoveryKit(
  identity: Omit<MemberRecoveryKit, "kind" | "code">,
): Promise<{ kit: MemberRecoveryKit; signer: StatementSigner }> {
  const secret = generateKitSecret();
  try {
    const kit: MemberRecoveryKit = {
      kind: "openclaw-member-recovery-kit",
      ...identity,
      code: (await encodeKit(secret)).replace(/^OCK1-/, "OCM1-"),
    };
    return { kit, signer: await deriveMemberRecoverySigner(secret) };
  } finally {
    secret.fill(0);
  }
}

/** Requires the whole export: the saved pin authenticates the claw after site-data loss. */
export async function readMemberRecoveryKit(
  text: string,
): Promise<{ kit: MemberRecoveryKit; signer: StatementSigner }> {
  if (text.length > 4096) {
    throw new Error("Recovery kit is too large.");
  }
  const value: unknown = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Paste the whole member recovery kit.");
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).toSorted().join(",") !== "account_id,claw_id,code,hostname,kind,root_fp" ||
    record.kind !== "openclaw-member-recovery-kit" ||
    !isRandomId(record.claw_id) ||
    typeof record.account_id !== "string" ||
    record.account_id.length === 0 ||
    record.account_id.length > 256 ||
    typeof record.hostname !== "string" ||
    record.hostname.length === 0 ||
    record.hostname.length > 256 ||
    !isKeyFingerprint(record.root_fp) ||
    typeof record.code !== "string" ||
    !/^OCM1-/i.test(record.code)
  ) {
    throw new Error("Paste the whole member recovery kit.");
  }
  // The strict field checks above establish the complete export shape.
  const kit = record as MemberRecoveryKit;
  const secret = await decodeKit(kit.code.replace(/^OCM1-/i, "OCK1-"));
  try {
    return { kit, signer: await deriveMemberRecoverySigner(secret) };
  } finally {
    secret.fill(0);
  }
}
