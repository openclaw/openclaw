import { describe, expect, it } from "vitest";
import { decryptAuditText, verifyChain } from "./audit.js";
import { generateIdentity } from "./identity.js";
import { MemoryAuditStore } from "./memory-stores.test-support.js";
import { confirmDelivery, signReceipt, verifyReceipt, type ReceiptBody } from "./receipts.js";

const auditKey = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const receiptBody: ReceiptBody = {
  id: "01JZ0000000000000000000000",
  bodyHash: "a".repeat(64),
  auditHead: "b".repeat(64),
  status: "accepted",
};
function receipt(secretKey: string, overrides: Partial<ReceiptBody> = {}) {
  return signReceipt({ ...receiptBody, ...overrides }, secretKey);
}

describe("audit", () => {
  it("builds and verifies an encrypted audit chain", async () => {
    const store = new MemoryAuditStore(auditKey);
    await store.appendEvent("proposal", { text: "secret message" }, 10);
    await store.appendEvent("guard_verdict", { reason: "looks safe" }, 11);
    await store.appendEvent("read", { ids: ["one"] }, 12);
    const entries = await store.entries();
    expect(verifyChain(entries, { head: entries.at(-1)!.entryHash, length: 3 })).toBe(true);
    expect(entries.at(-1)!.event.type).toBe("read");
    expect(
      entries.slice(0, 2).map((entry) => decryptAuditText(entry, auditKey).event.payload),
    ).toMatchObject([{ text: "secret message" }, { reason: "looks safe" }]);
  });

  it("detects mutation and externally anchored truncation", async () => {
    const store = new MemoryAuditStore(auditKey);
    await store.appendEvent("one", { value: 1 }, 10);
    await store.appendEvent("two", { value: 2 }, 11);
    const entries = await store.entries();
    const expected = { head: entries[1]!.entryHash, length: 2 };
    const mutated = { ...entries[0]!, event: { ...entries[0]!.event, type: "changed" } };
    expect(verifyChain([mutated, entries[1]!], expected)).toBe(false);
    expect(verifyChain(entries.slice(0, 1), expected)).toBe(false);
  });

  it("keeps plaintext out of the verifiable stored chain", async () => {
    const store = new MemoryAuditStore(auditKey);
    await store.appendEvent(
      "inbox",
      { text: "DO NOT LEAK ME", verdict: { reason: "ALSO PRIVATE" } },
      10,
    );
    const entries = await store.entries();
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain("DO NOT LEAK ME");
    expect(serialized).not.toContain("ALSO PRIVATE");
    expect(serialized).toContain('"enc"');
    expect(verifyChain(entries)).toBe(true);
  });

  it("serializes twenty concurrent appends into one valid chain", async () => {
    const store = new MemoryAuditStore(auditKey);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => store.appendEvent("concurrent", { index: i }, 100 + i)),
    );
    const entries = await store.entries();
    expect(entries.map((entry) => entry.event.seq)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 1),
    );
    expect(verifyChain(entries)).toBe(true);
  });
});

describe("receipts", () => {
  it("verifies and audits accepted and rejected delivery outcomes", async () => {
    const { signing } = generateIdentity();
    const audit = new MemoryAuditStore(auditKey);
    const accepted = receipt(signing.secretKey);
    const rejected = receipt(signing.secretKey, { status: "rejected", category: "guard_deny" });
    await confirmDelivery(accepted, signing.publicKey, audit);
    await confirmDelivery(rejected, signing.publicKey, audit);
    const entries = await audit.entries();
    expect(entries.map((entry) => entry.event)).toMatchObject([
      { type: "confirm_delivery", payload: { status: "accepted" } },
      { type: "confirm_delivery", payload: { status: "rejected", category: "guard_deny" } },
    ]);
    expect(entries[0]!.event.payload).not.toHaveProperty("category");
    await expect(
      confirmDelivery({ ...accepted, bodyHash: "e".repeat(64) }, signing.publicKey, audit),
    ).rejects.toThrow("invalid delivery receipt");
    for (const expected of [
      { id: accepted.id, bodyHash: "e".repeat(64) },
      { status: "rejected" as const },
    ]) {
      await expect(confirmDelivery(accepted, signing.publicKey, audit, expected)).rejects.toThrow(
        "invalid delivery receipt",
      );
    }
  });

  it("rejects unbounded and non-exact receipts before signature verification", () => {
    const { signing } = generateIdentity();
    const signed = receipt(signing.secretKey);
    expect(verifyReceipt({ ...signed, signature: "A".repeat(10_000) }, "not-a-key")).toBe(false);
    expect(verifyReceipt({ ...signed, category: "x".repeat(65) }, "not-a-key")).toBe(false);
    const extra = { ...signed, extra: true };
    expect(verifyReceipt(extra, "not-a-key")).toBe(false);
  });
});
