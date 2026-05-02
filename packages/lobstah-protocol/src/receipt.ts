import { canonicalize } from "./canonical.js";
import { fromHex, parsePubkey, sign, toHex, verify } from "./identity.js";

export type Receipt = {
  version: 1;
  jobId: string;
  nonce: string;
  requesterPubkey: string;
  workerPubkey: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  startedAt: number;
  completedAt: number;
};

export type SignedReceipt = {
  receipt: Receipt;
  signature: string;
};

export const MAX_RECEIPT_AGE_MS = 5 * 60 * 1000;

export const generateNonce = (): string => {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return toHex(buf);
};

const enc = new TextEncoder();

export const signReceipt = (receipt: Receipt, workerSecretKey: Uint8Array): SignedReceipt => {
  const signature = sign(enc.encode(canonicalize(receipt)), workerSecretKey);
  return { receipt, signature: toHex(signature) };
};

export const verifyReceipt = (signed: SignedReceipt): boolean => {
  try {
    const workerPk = parsePubkey(signed.receipt.workerPubkey);
    return verify(fromHex(signed.signature), enc.encode(canonicalize(signed.receipt)), workerPk);
  } catch {
    return false;
  }
};

export const isReceiptFresh = (r: Receipt, now: number = Date.now()): boolean => {
  return now - r.completedAt <= MAX_RECEIPT_AGE_MS && r.completedAt - now <= MAX_RECEIPT_AGE_MS;
};

export const totalTokens = (r: Receipt): number => r.inputTokens + r.outputTokens;
