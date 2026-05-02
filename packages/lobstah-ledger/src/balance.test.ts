import {
  formatPubkey,
  generateIdentity,
  type Receipt,
  signReceipt,
  type SignedReceipt,
} from "@lobstah/protocol";
import { describe, expect, it } from "vitest";
import { computeBalances } from "./balance.js";

const make = (
  workerPk: string,
  requesterPk: string,
  inputTokens: number,
  outputTokens: number,
  jobId: string,
): Receipt => ({
  version: 1,
  jobId,
  nonce: jobId.padEnd(32, "0"),
  workerPubkey: workerPk,
  requesterPubkey: requesterPk,
  model: "llama3.1:8b",
  inputTokens,
  outputTokens,
  startedAt: 0,
  completedAt: 1000,
});

describe("computeBalances", () => {
  it("returns empty totals for no receipts", () => {
    const s = computeBalances([]);
    expect(s.totals).toEqual({ earned: 0, spent: 0, receipts: 0 });
    expect(s.perPeer.size).toBe(0);
  });

  it("attributes a single receipt to worker and requester", () => {
    const worker = generateIdentity();
    const requester = generateIdentity();
    const wPk = formatPubkey(worker.publicKey);
    const rPk = formatPubkey(requester.publicKey);
    const signed = signReceipt(make(wPk, rPk, 10, 20, "j1"), worker.secretKey);

    const s = computeBalances([signed]);
    expect(s.totals.receipts).toBe(1);
    expect(s.totals.earned).toBe(30);
    expect(s.totals.spent).toBe(30);
    expect(s.perPeer.get(wPk)).toEqual({ pubkey: wPk, earned: 30, spent: 0, net: 30 });
    expect(s.perPeer.get(rPk)).toEqual({ pubkey: rPk, earned: 0, spent: 30, net: -30 });
  });

  it("excludes receipts with bad signatures", () => {
    const worker = generateIdentity();
    const wrongSigner = generateIdentity();
    const requester = generateIdentity();
    const wPk = formatPubkey(worker.publicKey);
    const rPk = formatPubkey(requester.publicKey);
    const forged = signReceipt(make(wPk, rPk, 10, 20, "j1"), wrongSigner.secretKey);
    const s = computeBalances([forged]);
    expect(s.totals.receipts).toBe(0);
    expect(s.perPeer.size).toBe(0);
  });

  it("aggregates across multiple receipts and peers", () => {
    const w1 = generateIdentity();
    const w2 = generateIdentity();
    const r = generateIdentity();
    const w1Pk = formatPubkey(w1.publicKey);
    const w2Pk = formatPubkey(w2.publicKey);
    const rPk = formatPubkey(r.publicKey);

    const receipts: SignedReceipt[] = [
      signReceipt(make(w1Pk, rPk, 5, 10, "j1"), w1.secretKey),
      signReceipt(make(w1Pk, rPk, 7, 14, "j2"), w1.secretKey),
      signReceipt(make(w2Pk, rPk, 3, 6, "j3"), w2.secretKey),
    ];
    const s = computeBalances(receipts);

    expect(s.totals.receipts).toBe(3);
    expect(s.totals.earned).toBe(45);
    expect(s.perPeer.get(w1Pk)?.earned).toBe(36);
    expect(s.perPeer.get(w2Pk)?.earned).toBe(9);
    expect(s.perPeer.get(rPk)?.spent).toBe(45);
    expect(s.perPeer.get(rPk)?.net).toBe(-45);
  });
});
