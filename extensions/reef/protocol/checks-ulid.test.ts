import { describe, expect, it } from "vitest";
import { deterministicChecks } from "./checks.js";
import { createMonotonicUlidFactory } from "./ulid.js";

// Secret-shaped fixtures are assembled at runtime so the source never contains
// scanner-matching literals (GitHub push protection, review bundlers).
const fake = (...parts: string[]) => parts.join("");

describe("deterministic checks", () => {
  it("denies the secret corpus without a model call", () => {
    for (const text of [
      fake("-----BEGIN PRIVATE", " KEY-----"),
      fake("sk-", "abcdefghijklmnopqrstuvwxyz123456"),
      fake("ghp", "_abcdefghijklmnopqrstuvwxyz123456"),
      fake("gho", "_abcdefghijklmnopqrstuvwxyz123456"),
      fake("AKIA", "IOSFODNN7EXAMPLE"),
      fake("xoxb", "-123456789012-abcdefghijklmnop"),
      fake("eyJ", "abcdefghij.abcdefghijkl.abcdefghijkl"),
      fake("4f9e8d7c6b5a4321", "0f9e8d7c6b5a4321", "4f9e8d7c6b5a4321", "0f9e8d7c6b5a4321"),
      fake("Q7vN2kLm9Pz4Rxa8", "CwT5Yb3Hj6Uf1Ds0GeKqVnM2LX8"),
    ]) {
      expect(deterministicChecks(text), text).toMatchObject({ allowed: false });
    }
  });

  it("allows the benign corpus", () => {
    for (const text of [
      "meeting at ten",
      "00000000000000000000000000000000",
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "The pneumonoultramicroscopicsilicovolcanoconiosis example is benign.",
    ]) {
      expect(deterministicChecks(text), text).toEqual({ allowed: true, text, findings: [] });
    }
  });

  it("keeps entropy checks outside the exact GitHub revision occurrence", () => {
    const hash = "430f975aacee445525c4663aa88ed1590f2f08b1";
    const commit = `https://github.com/openclaw/openclaw/commit/${hash}`;
    for (const text of [
      hash,
      `${commit} and token=${hash}`,
      `${commit}?token=${hash}`,
      `${commit}#token=${hash}`,
      `${commit}/${hash}`,
      `https://user:password@github.com/openclaw/openclaw/commit/${hash}`,
      `https://github.com:8443/openclaw/openclaw/commit/${hash}`,
      `https://${hash}@github.com/openclaw/openclaw/commit/${hash}`,
      `https://user:${hash}@github.com/openclaw/openclaw/commit/${hash}`,
      `https://github.com.example.org/openclaw/openclaw/commit/${hash}`,
      `https://github.com@evil.example/openclaw/openclaw/commit/${hash}`,
      `https://example.org/openclaw/openclaw/commit/${hash}`,
      `https://example.org/?next=${commit}`,
      `https://example.org/#${commit}`,
      `https://example.org/?next='${commit}`,
      `https://example.org/#'${commit}`,
      `_https://example.org/?next=${commit}/file_`,
      `1https://example.org/?next=${commit}`,
      `.https://example.org/?next=${commit}`,
      `mailto:review@example.org?next=${commit}`,
      `data:text/plain,${commit}`,
      `https://github.com/openclaw/openclaw/issues/${hash}`,
      `https://github.com/openclaw/openclaw/blob/main/${hash}`,
      `${commit}abcdef`,
      `${commit}-secret`,
      commit.slice(0, -1),
      `${commit} ${fake("Q7vN2kLm9Pz4Rxa8", "CwT5Yb3Hj6Uf1Ds0GeKqVnM2LX8")}`,
    ]) {
      expect(deterministicChecks(text), text).toMatchObject({
        allowed: false,
        findings: [{ code: "high_entropy_token", decision: "deny" }],
      });
    }
  });

  it("keeps known credential checks throughout GitHub URLs", () => {
    const token = fake("ghp", "_", "a".repeat(24));
    const hash = "430f975aacee445525c4663aa88ed1590f2f08b1";
    for (const text of [
      `https://github.com/openclaw/${token}/commit/${hash}`,
      `https://github.com/openclaw/openclaw/commit/${token}`,
      `https://github.com/openclaw/openclaw/blob/${hash}/${token}`,
      `https://github.com/openclaw/openclaw/commit/${hash}?token=${token}`,
      `https://github.com/openclaw/openclaw/commit/${hash}#${token}`,
      `https://user:${token}@github.com/openclaw/openclaw/commit/${hash}`,
    ]) {
      expect(deterministicChecks(text), text).toMatchObject({
        allowed: false,
        findings: expect.arrayContaining([{ code: "github_token", decision: "deny" }]),
      });
    }
  });

  it("rejects invalid UTF-8 and oversize input", () => {
    expect(deterministicChecks(Uint8Array.of(0xc3, 0x28)).findings[0]?.code).toBe("invalid_utf8");
    expect(deterministicChecks("x".repeat(32 * 1024 + 1)).findings[0]?.code).toBe("too_large");
  });
});

describe("monotonic ULIDs", () => {
  it("is deterministic and monotonic with injected clock and rng", () => {
    const make = createMonotonicUlidFactory({ clock: () => 1_000, rng: () => new Uint8Array(10) });
    const first = make();
    const second = make();
    expect(first).toBe("00000000Z80000000000000000");
    expect(second).toBe("00000000Z80000000000000001");
    expect(second > first).toBe(true);
  });
});
