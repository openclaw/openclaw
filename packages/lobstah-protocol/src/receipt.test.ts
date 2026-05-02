import { describe, expect, it } from "vitest";
import { formatPubkey, generateIdentity } from "./identity.js";
import {
  generateNonce,
  isReceiptFresh,
  MAX_RECEIPT_AGE_MS,
  type Receipt,
  signReceipt,
  totalTokens,
  verifyReceipt,
} from "./receipt.js";

const sample = (
  workerPk: string,
  requesterPk: string,
  overrides: Partial<Receipt> = {},
): Receipt => ({
  version: 1,
  jobId: "job-001",
  nonce: "00000000000000000000000000000001",
  workerPubkey: workerPk,
  requesterPubkey: requesterPk,
  model: "llama3.1:8b",
  inputTokens: 15,
  outputTokens: 22,
  startedAt: 1000,
  completedAt: 2000,
  ...overrides,
});

describe("receipt", () => {
  it("round-trips sign + verify", () => {
    const worker = generateIdentity();
    const requester = generateIdentity();
    const r = sample(formatPubkey(worker.publicKey), formatPubkey(requester.publicKey));
    const signed = signReceipt(r, worker.secretKey);
    expect(verifyReceipt(signed)).toBe(true);
  });

  it("detects tampering of inputTokens", () => {
    const worker = generateIdentity();
    const requester = generateIdentity();
    const r = sample(formatPubkey(worker.publicKey), formatPubkey(requester.publicKey));
    const signed = signReceipt(r, worker.secretKey);
    const tampered = { ...signed, receipt: { ...signed.receipt, inputTokens: 99 } };
    expect(verifyReceipt(tampered)).toBe(false);
  });

  it("detects tampering of model field", () => {
    const worker = generateIdentity();
    const requester = generateIdentity();
    const r = sample(formatPubkey(worker.publicKey), formatPubkey(requester.publicKey));
    const signed = signReceipt(r, worker.secretKey);
    const tampered = { ...signed, receipt: { ...signed.receipt, model: "gpt-4" } };
    expect(verifyReceipt(tampered)).toBe(false);
  });

  it("detects tampering of nonce", () => {
    const worker = generateIdentity();
    const requester = generateIdentity();
    const r = sample(formatPubkey(worker.publicKey), formatPubkey(requester.publicKey));
    const signed = signReceipt(r, worker.secretKey);
    const tampered = {
      ...signed,
      receipt: { ...signed.receipt, nonce: "ffffffffffffffffffffffffffffffff" },
    };
    expect(verifyReceipt(tampered)).toBe(false);
  });

  it("rejects a receipt signed by the wrong key", () => {
    const worker = generateIdentity();
    const otherWorker = generateIdentity();
    const requester = generateIdentity();
    const r = sample(formatPubkey(worker.publicKey), formatPubkey(requester.publicKey));
    const signed = signReceipt(r, otherWorker.secretKey);
    expect(verifyReceipt(signed)).toBe(false);
  });

  it("returns false on malformed input rather than throwing", () => {
    const broken = { receipt: { workerPubkey: "not-a-pubkey" }, signature: "0011" } as never;
    expect(verifyReceipt(broken)).toBe(false);
  });

  it("totalTokens sums input + output", () => {
    expect(totalTokens(sample("lob1a", "lob1b"))).toBe(37);
  });
});

describe("generateNonce", () => {
  it("returns 32 hex chars (16 random bytes)", () => {
    const n = generateNonce();
    expect(n).toMatch(/^[0-9a-f]{32}$/);
  });

  it("returns distinct values across many calls", () => {
    const set = new Set(Array.from({ length: 200 }, () => generateNonce()));
    expect(set.size).toBe(200);
  });
});

describe("isReceiptFresh", () => {
  it("accepts a receipt completed just now", () => {
    const r = sample("lob1a", "lob1b", { completedAt: 1_000_000 });
    expect(isReceiptFresh(r, 1_000_000)).toBe(true);
  });

  it("accepts a receipt within the freshness window", () => {
    const r = sample("lob1a", "lob1b", { completedAt: 1_000_000 });
    expect(isReceiptFresh(r, 1_000_000 + MAX_RECEIPT_AGE_MS - 1)).toBe(true);
  });

  it("rejects a receipt older than the freshness window", () => {
    const r = sample("lob1a", "lob1b", { completedAt: 1_000_000 });
    expect(isReceiptFresh(r, 1_000_000 + MAX_RECEIPT_AGE_MS + 1)).toBe(false);
  });

  it("rejects a receipt dated far in the future (clock skew defense)", () => {
    const r = sample("lob1a", "lob1b", { completedAt: 1_000_000 + MAX_RECEIPT_AGE_MS + 1 });
    expect(isReceiptFresh(r, 1_000_000)).toBe(false);
  });
});
