import { expect, it } from "vitest";
import { deterministicChecks, type CheckFinding } from "./checks.js";
import { createMonotonicUlidFactory } from "./ulid.js";

// Assemble secret-shaped fixtures to avoid source-scanner matches.
const fake = (...parts: string[]) => parts.join("");
const hash = "430f975aacee445525c4663aa88ed1590f2f08b1";
const commit = `https://github.com/openclaw/openclaw/commit/${hash}`;
const entropyToken = fake("Q7vN2kLm9Pz4Rxa8", "CwT5Yb3Hj6Uf1Ds0GeKqVnM2LX8");
const token = fake("ghp", "_", "a".repeat(24));
it.each([
  [
    "the secret corpus without a model call",
    [
      fake("-----BEGIN PRIVATE", " KEY-----"),
      fake("sk-", "abcdefghijklmnopqrstuvwxyz123456"),
      fake("ghp", "_abcdefghijklmnopqrstuvwxyz123456"),
      fake("gho", "_abcdefghijklmnopqrstuvwxyz123456"),
      fake("AKIA", "IOSFODNN7EXAMPLE"),
      fake("xoxb", "-123456789012-abcdefghijklmnop"),
      fake("eyJ", "abcdefghij.abcdefghijkl.abcdefghijkl"),
      fake("4f9e8d7c6b5a4321", "0f9e8d7c6b5a4321", "4f9e8d7c6b5a4321", "0f9e8d7c6b5a4321"),
      entropyToken,
    ],
    expect.any(Array),
  ],
  [
    "entropy outside the exact GitHub revision occurrence",
    [
      hash,
      ...[" and token=", "?token=", "#token=", "/"].map((suffix) => `${commit}${suffix}${hash}`),
      ...[
        "user:password@github.com",
        "github.com:8443",
        `${hash}@github.com`,
        `user:${hash}@github.com`,
        "github.com.example.org",
        "github.com@evil.example",
        "example.org",
      ].map((host) => `https://${host}/openclaw/openclaw/commit/${hash}`),
      ...["?next=", "#", "?next='", "#'"].map((suffix) => `https://example.org/${suffix}${commit}`),
      `_https://example.org/?next=${commit}/file_`,
      ...["1", "."].map((prefix) => `${prefix}https://example.org/?next=${commit}`),
      `mailto:review@example.org?next=${commit}`,
      `data:text/plain,${commit}`,
      `https://github.com/openclaw/openclaw/issues/${hash}`,
      `https://github.com/openclaw/openclaw/blob/main/${hash}`,
      `${commit}abcdef`,
      `${commit}-secret`,
      commit.slice(0, -1),
      `${commit} ${entropyToken}`,
    ],
    [{ code: "high_entropy_token", decision: "deny" }],
  ],
  [
    "known credentials throughout GitHub URLs",
    [
      `https://github.com/openclaw/${token}/commit/${hash}`,
      `https://github.com/openclaw/openclaw/commit/${token}`,
      `https://github.com/openclaw/openclaw/blob/${hash}/${token}`,
      `https://github.com/openclaw/openclaw/commit/${hash}?token=${token}`,
      `https://github.com/openclaw/openclaw/commit/${hash}#${token}`,
      `https://user:${token}@github.com/openclaw/openclaw/commit/${hash}`,
    ],
    expect.arrayContaining([{ code: "github_token", decision: "deny" }]),
  ],
] satisfies [string, string[], CheckFinding[]][])("denies %s", (_name, texts, findings) => {
  for (const text of texts) {
    expect(deterministicChecks(text), text).toMatchObject({ allowed: false, findings });
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

it("rejects invalid UTF-8 and oversize input", () => {
  expect(deterministicChecks(Uint8Array.of(0xc3, 0x28)).findings[0]?.code).toBe("invalid_utf8");
  expect(deterministicChecks("x".repeat(32 * 1024 + 1)).findings[0]?.code).toBe("too_large");
});

it("generates deterministic, monotonic ULIDs with injected clock and rng", () => {
  const make = createMonotonicUlidFactory({ clock: () => 1_000, rng: () => new Uint8Array(10) });
  const first = make();
  const second = make();
  expect([first, second]).toEqual(["00000000Z80000000000000000", "00000000Z80000000000000001"]);
  expect(second > first).toBe(true);
});
