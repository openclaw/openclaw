// Sandbox env sanitizer tests cover credential filtering for inherited and
// explicitly configured sandbox environment variables.
import { describe, expect, it } from "vitest";
import { sanitizeEnvVars, sanitizeExplicitSandboxEnvVars } from "./sanitize-env-vars.js";

describe("sanitizeEnvVars", () => {
  it("keeps normal env vars and blocks obvious credentials", () => {
    const result = sanitizeEnvVars({
      NODE_ENV: "test",
      OPENAI_API_KEY: "sk-live-xxx", // pragma: allowlist secret
      OPENAI_ADMIN_KEY: "sk-admin-live-xxx", // pragma: allowlist secret
      ANTHROPIC_ADMIN_KEY: "sk-ant-admin-live-xxx", // pragma: allowlist secret
      ANTHROPIC_ADMIN_API_KEY: "sk-ant-admin-api-live-xxx", // pragma: allowlist secret
      FOO: "bar",
      GITHUB_TOKEN: "gh-token", // pragma: allowlist secret
    });

    expect(result.allowed).toEqual({
      NODE_ENV: "test",
      FOO: "bar",
    });
    expect(result.blocked).toStrictEqual([
      "OPENAI_API_KEY",
      "OPENAI_ADMIN_KEY",
      "ANTHROPIC_ADMIN_KEY",
      "ANTHROPIC_ADMIN_API_KEY",
      "GITHUB_TOKEN",
    ]);
  });

  it("blocks credentials even when suffix pattern matches", () => {
    const result = sanitizeEnvVars({
      MY_TOKEN: "abc",
      MY_SECRET: "def",
      USER: "alice",
    });

    expect(result.allowed).toEqual({ USER: "alice" });
    expect(result.blocked).toStrictEqual(["MY_TOKEN", "MY_SECRET"]);
  });

  it("adds warnings for suspicious values", () => {
    const base64Like =
      "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==";
    const result = sanitizeEnvVars({
      USER: "alice",
      SAFE_TEXT: base64Like,
      NULL: "a\0b",
    });

    expect(result.allowed).toEqual({ USER: "alice", SAFE_TEXT: base64Like });
    expect(result.blocked).toContain("NULL");
    expect(result.warnings).toContain("SAFE_TEXT: Value looks like base64-encoded credential data");
  });

  it("supports strict mode with explicit allowlist", () => {
    const result = sanitizeEnvVars(
      {
        NODE_ENV: "test",
        FOO: "bar",
      },
      { strictMode: true },
    );

    expect(result.allowed).toEqual({ NODE_ENV: "test" });
    expect(result.blocked).toEqual(["FOO"]);
  });

  it("skips undefined values when sanitizing process-style env maps", () => {
    const result = sanitizeEnvVars({
      NODE_ENV: "test",
      OPTIONAL_SECRET: undefined,
      OPENAI_API_KEY: undefined,
    });

    expect(result.allowed).toEqual({ NODE_ENV: "test" });
    expect(result.blocked).toStrictEqual([]);
  });

  it("allows explicit configured sandbox env names that look like credentials", () => {
    // Explicit sandbox env config is operator intent; value validation still
    // runs, but name-based credential blocking does not.
    const result = sanitizeExplicitSandboxEnvVars({
      GEMINI_API_KEY: "dummy-gemini-api-key",
      GOOGLE_CLIENT_SECRET: "dummy-google-client-secret",
      HIMALAYA_PASSWORD: "dummy-himalaya-password",
      RESEND_API_KEY: "dummy-resend-api-key",
    });

    expect(result.allowed).toEqual({
      GEMINI_API_KEY: "dummy-gemini-api-key",
      GOOGLE_CLIENT_SECRET: "dummy-google-client-secret",
      HIMALAYA_PASSWORD: "dummy-himalaya-password",
      RESEND_API_KEY: "dummy-resend-api-key",
    });
    expect(result.blocked).toStrictEqual([]);
  });

  it("still blocks invalid explicit configured sandbox env values", () => {
    const result = sanitizeExplicitSandboxEnvVars({
      SAFE_SECRET: "ok",
      NULL_SECRET: "a\0b",
    });

    expect(result.allowed).toEqual({ SAFE_SECRET: "ok" });
    expect(result.blocked).toStrictEqual(["NULL_SECRET"]);
  });

  it("warns on multi-byte values whose UTF-8 byte length exceeds the limit", () => {
    // Each CJK character is 3 UTF-8 bytes; 11000 chars × 3 bytes = 33000 bytes > 32768.
    const multiByteValue = "值".repeat(11000);
    expect(multiByteValue.length).toBe(11000); // UTF-16 length is below 32768
    expect(Buffer.byteLength(multiByteValue, "utf8")).toBe(33000); // but UTF-8 exceeds limit

    const result = sanitizeEnvVars({ MULTIBYTE: multiByteValue });
    expect(result.allowed).toEqual({ MULTIBYTE: multiByteValue });
    expect(result.warnings).toContain("MULTIBYTE: Value exceeds maximum length");
  });

  it("allows ASCII values at the byte limit boundary", () => {
    // Use characters outside the base64 charset to avoid triggering the
    // base64-credential heuristic, which runs before the length check.
    const atLimit = "a!b!".repeat(8192); // 8192*4 = 32768 bytes, contains !
    const overLimit = atLimit + "x"; // 32769 bytes

    expect(sanitizeEnvVars({ AT_LIMIT: atLimit }).warnings).toStrictEqual([]);
    expect(sanitizeEnvVars({ OVER_LIMIT: overLimit }).warnings).toContain(
      "OVER_LIMIT: Value exceeds maximum length",
    );
  });
});
