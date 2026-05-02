import { describe, expect, it } from "vitest";
import { formatPubkey, generateIdentity, parsePubkey, sign, verify } from "./identity.js";

describe("identity", () => {
  it("generates 32-byte keypair", () => {
    const id = generateIdentity();
    expect(id.publicKey).toBeInstanceOf(Uint8Array);
    expect(id.publicKey.length).toBe(32);
    expect(id.secretKey).toBeInstanceOf(Uint8Array);
    expect(id.secretKey.length).toBe(32);
  });

  it("signs and verifies a message", () => {
    const id = generateIdentity();
    const msg = new TextEncoder().encode("hello world");
    const sig = sign(msg, id.secretKey);
    expect(sig.length).toBe(64);
    expect(verify(sig, msg, id.publicKey)).toBe(true);
  });

  it("rejects a tampered message", () => {
    const id = generateIdentity();
    const msg = new TextEncoder().encode("hello world");
    const sig = sign(msg, id.secretKey);
    const tampered = new TextEncoder().encode("hello world!");
    expect(verify(sig, tampered, id.publicKey)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = generateIdentity();
    const b = generateIdentity();
    const msg = new TextEncoder().encode("hi");
    const sigByA = sign(msg, a.secretKey);
    expect(verify(sigByA, msg, b.publicKey)).toBe(false);
  });

  it("formats and parses a pubkey round-trip", () => {
    const id = generateIdentity();
    const formatted = formatPubkey(id.publicKey);
    expect(formatted).toMatch(/^lob1[0-9a-f]{64}$/);
    expect(parsePubkey(formatted)).toEqual(id.publicKey);
  });

  it("rejects malformed pubkeys", () => {
    expect(() => parsePubkey("badkey")).toThrow();
    expect(() => parsePubkey("lob1xx")).toThrow();
  });
});
