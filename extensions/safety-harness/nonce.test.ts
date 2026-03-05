import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { generateNonce, NonceChallenge } from "./nonce.js";

describe("generateNonce", () => {
  it("generates a 6-digit numeric code", () => {
    const nonce = generateNonce();
    expect(nonce).toMatch(/^\d{6}$/);
  });

  it("generates unique nonces", () => {
    const nonces = new Set();
    for (let i = 0; i < 100; i++) {
      nonces.add(generateNonce());
    }
    expect(nonces.size).toBe(100);
  });
});

describe("NonceChallenge", () => {
  it("creates a challenge with expiry", () => {
    const challenge = new NonceChallenge("email.delete", { count: 3 }, 300_000);
    expect(challenge.nonce).toMatch(/^\d{6}$/);
    expect(challenge.tool).toBe("email.delete");
    expect(challenge.expiresAt).toBeGreaterThan(Date.now());
  });

  it("verifies correct nonce", () => {
    const challenge = new NonceChallenge("email.delete", { count: 3 }, 300_000);
    expect(challenge.verify(challenge.nonce)).toBe(true);
  });

  it("rejects wrong nonce", () => {
    const challenge = new NonceChallenge("email.delete", { count: 3 }, 300_000);
    expect(challenge.verify("000000")).toBe(false);
  });

  it("rejects expired nonce", () => {
    vi.useFakeTimers();
    const challenge = new NonceChallenge("email.delete", { count: 3 }, 5_000);
    vi.advanceTimersByTime(6_000);
    expect(challenge.verify(challenge.nonce)).toBe(false);
    vi.useRealTimers();
  });

  it("checks isExpired", () => {
    vi.useFakeTimers();
    const challenge = new NonceChallenge("email.delete", { count: 3 }, 5_000);
    expect(challenge.isExpired()).toBe(false);
    vi.advanceTimersByTime(6_000);
    expect(challenge.isExpired()).toBe(true);
    vi.useRealTimers();
  });
});
