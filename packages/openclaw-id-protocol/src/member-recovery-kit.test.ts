import { describe, expect, it } from "vitest";
import { formatEd25519PublicKey } from "./keys.js";
import { decodeKit, deriveRootSigner } from "./kit.js";
import {
  createMemberRecoveryKit,
  deriveMemberRecoverySigner,
  readMemberRecoveryKit,
} from "./member-recovery-kit.js";

describe("member kit artifact", () => {
  it("round trips its account and independent claw pin without deriving owner authority", async () => {
    const identity = {
      claw_id: "12".repeat(16),
      account_id: "synthetic-member",
      hostname: "recovery.example.test",
      root_fp: `fp:${"34".repeat(32)}` as const,
    };
    const created = await createMemberRecoveryKit(identity);
    expect(created.kit).toMatchObject(identity);
    expect(created.kit.code).toMatch(/^OCM1-/);
    const loaded = await readMemberRecoveryKit(JSON.stringify(created.kit));
    expect(formatEd25519PublicKey(loaded.signer.publicKey)).toBe(
      formatEd25519PublicKey(created.signer.publicKey),
    );
    await expect(decodeKit(created.kit.code)).rejects.toThrow("not an OCK1 kit");
    const secret = new Uint8Array(16).fill(7);
    expect(formatEd25519PublicKey((await deriveMemberRecoverySigner(secret)).publicKey)).not.toBe(
      formatEd25519PublicKey((await deriveRootSigner(secret)).publicKey),
    );
  });
  it("requires the whole artifact and refuses malformed identities and owner codes", async () => {
    const { kit } = await createMemberRecoveryKit({
      claw_id: "12".repeat(16),
      account_id: "member",
      hostname: "recovery.example.test",
      root_fp: `fp:${"34".repeat(32)}`,
    });
    for (const changed of [
      { ...kit, code: kit.code.replace("OCM1", "OCK1") },
      { ...kit, claw_id: "wrong" },
      { ...kit, root_fp: "wrong" },
      { ...kit, account_id: "" },
      { ...kit, unknown: true },
      { code: kit.code },
    ]) {
      await expect(readMemberRecoveryKit(JSON.stringify(changed))).rejects.toThrow();
    }
    await expect(readMemberRecoveryKit(kit.code)).rejects.toThrow();
  });
});
