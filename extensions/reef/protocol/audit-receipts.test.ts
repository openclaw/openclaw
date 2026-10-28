import { expect, it } from "vitest";
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
const receipt = (secretKey: string, overrides: Partial<ReceiptBody> = {}) =>
  signReceipt({ ...receiptBody, ...overrides }, secretKey);

it("serializes concurrent encrypted appends and detects mutation and truncation", async () => {
  const store = new MemoryAuditStore(auditKey);
  const payload = { text: "secret", verdict: { reason: "private" } };
  await Promise.all([
    store.appendEvent("proposal", payload, 10),
    store.appendEvent("guard_verdict", { reason: "looks safe" }, 11),
    store.appendEvent("read", { ids: ["one"] }, 12),
  ]);
  const entries = await store.entries();
  const expected = { head: entries.at(-1)!.entryHash, length: 3 };
  expect(entries.map((entry) => entry.event.seq)).toEqual([1, 2, 3]);
  expect(verifyChain(entries, expected)).toBe(true);
  expect(verifyChain(entries)).toBe(true);
  expect(entries.at(-1)!.event.type).toBe("read");
  expect(
    entries.slice(0, 2).map((entry) => decryptAuditText(entry, auditKey).event.payload),
  ).toEqual([payload, { reason: "looks safe" }]);
  const mutated = { ...entries[0]!, event: { ...entries[0]!.event, type: "changed" } };
  expect(verifyChain([mutated, ...entries.slice(1)], expected)).toBe(false);
  expect(verifyChain(entries.slice(0, 1), expected)).toBe(false);
  const serialized = JSON.stringify(entries);
  expect(serialized).not.toContain("secret");
  expect(serialized).not.toContain("private");
  expect(serialized).toContain('"enc"');
});

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
  for (const fields of [
    { signature: "A".repeat(10_000) },
    { category: "x".repeat(65) },
    { extra: true },
  ]) {
    expect(verifyReceipt({ ...accepted, ...fields }, "not-a-key")).toBe(false);
  }
});
