import { gcm } from "@noble/ciphers/aes.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { canonicalBytes } from "./canonical.js";
import { base64, decodeUtf8, fromBase64, hex, utf8 } from "./encoding.js";

export interface AuditEvent {
  seq: number;
  ts: number;
  type: string;
  payload: unknown;
}

export interface AuditEntry {
  event: AuditEvent;
  prevHash: string;
  entryHash: string;
}

export interface AuditStore {
  appendEvent(type: string, payload: unknown, ts?: number): Promise<AuditEntry>;
  entries(): Promise<AuditEntry[]>;
}

interface AuditHead {
  hash: string;
  seq: number;
}

export function verifyChain(
  entries: readonly AuditEntry[],
  expected?: { head?: string; length?: number },
): boolean {
  if (expected?.length !== undefined && entries.length !== expected.length) {
    return false;
  }
  return verifyChainSegment(entries, {
    previousHash: "",
    previousSeq: 0,
    ...(expected?.head === undefined ? {} : { head: expected.head }),
  });
}

export function verifyChainSegment(
  entries: readonly AuditEntry[],
  expected: { previousHash: string; previousSeq: number; head?: string },
): boolean {
  let previous = expected.previousHash;
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]!;
    if (
      entry.event.seq !== expected.previousSeq + index + 1 ||
      entry.prevHash !== previous ||
      entry.entryHash !== hashEntry(previous, entry.event)
    ) {
      return false;
    }
    previous = entry.entryHash;
  }
  return expected.head === undefined || previous === expected.head;
}

export function decryptAuditText(entry: AuditEntry, auditKey: Uint8Array): AuditEntry {
  const key = validateAuditKey(auditKey);
  return {
    ...structuredClone(entry),
    event: { ...structuredClone(entry.event), payload: decryptSensitive(entry.event.payload, key) },
  };
}

export function createAuditEntry(
  type: string,
  payload: unknown,
  ts: number,
  auditKey: Uint8Array,
  head: AuditHead,
  rng: (length: number) => Uint8Array = randomBytes,
): AuditEntry {
  if (typeof type !== "string" || type.length === 0 || !Number.isSafeInteger(ts) || ts < 0) {
    throw new Error("invalid audit event");
  }
  const event: AuditEvent = {
    seq: head.seq + 1,
    ts,
    type,
    payload: encryptSensitive(payload, validateAuditKey(auditKey), rng),
  };
  return { event, prevHash: head.hash, entryHash: hashEntry(head.hash, event) };
}

function encryptSensitive(
  value: unknown,
  key: Uint8Array,
  rng: (length: number) => Uint8Array,
): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => encryptSensitive(child, key, rng));
  }
  if (value !== null && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [field, child] of Object.entries(value)) {
      if ((field === "text" || field === "reason") && typeof child === "string") {
        const nonce = rng(12);
        if (nonce.length !== 12) {
          throw new Error("invalid audit nonce");
        }
        const ciphertext = gcm(key, nonce).encrypt(utf8(child));
        output[field] = { enc: base64(concatBytes(nonce, ciphertext)) };
      } else {
        output[field] = encryptSensitive(child, key, rng);
      }
    }
    return output;
  }
  return value;
}

function decryptSensitive(value: unknown, key: Uint8Array, field?: string): unknown {
  if (Array.isArray(value)) {
    return value.map((child) => decryptSensitive(child, key));
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (
      (field === "text" || field === "reason") &&
      Object.keys(record).length === 1 &&
      typeof record.enc === "string"
    ) {
      const combined = fromBase64(record.enc);
      if (combined.length < 28) {
        throw new Error("invalid encrypted audit field");
      }
      return decodeUtf8(gcm(key, combined.slice(0, 12)).decrypt(combined.slice(12)));
    }
    return Object.fromEntries(
      Object.entries(record).map(([childField, child]) => [
        childField,
        decryptSensitive(child, key, childField),
      ]),
    );
  }
  return value;
}

function hashEntry(previous: string, event: AuditEvent): string {
  const previousBytes = previous === "" ? new Uint8Array() : fromHex(previous);
  const eventBytes = canonicalBytes(event);
  return hex(sha256(concatBytes(previousBytes, eventBytes)));
}

function validateAuditKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== 32) {
    throw new Error("audit key must be 32 bytes");
  }
  return key;
}

function fromHex(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid audit hash");
  }
  return Uint8Array.from(value.match(/../g)!, (part) => Number.parseInt(part, 16));
}
