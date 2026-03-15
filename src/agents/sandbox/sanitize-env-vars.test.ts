import { describe, expect, it } from "vitest";
import { sanitizeEnvVars, validateEnvVarValue } from "./sanitize-env-vars.js";

describe("sanitizeEnvVars", () => {
  it("keeps normal env vars and blocks obvious credentials", () => {
    const result = sanitizeEnvVars({
      NODE_ENV: "test",
      OPENAI_API_KEY: "sk-live-xxx", // pragma: allowlist secret
      FOO: "bar",
      GITHUB_TOKEN: "gh-token", // pragma: allowlist secret
    });

    expect(result.allowed).toEqual({
      NODE_ENV: "test",
      FOO: "bar",
    });
    expect(result.blocked).toEqual(expect.arrayContaining(["OPENAI_API_KEY", "GITHUB_TOKEN"]));
  });

  it("blocks credentials even when suffix pattern matches", () => {
    const result = sanitizeEnvVars({
      MY_TOKEN: "abc",
      MY_SECRET: "def",
      USER: "alice",
    });

    expect(result.allowed).toEqual({ USER: "alice" });
    expect(result.blocked).toEqual(expect.arrayContaining(["MY_TOKEN", "MY_SECRET"]));
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

  it("does not flag long alphanumeric strings without base64 characteristics", () => {
    // A long hex string (e.g. SHA-256 hash repeated) — no +, /, or = so not base64
    const longHex = "a]b]c".replace(/]/g, "").padEnd(80, "0").repeat(1).slice(0, 80);
    const longAlphanumeric = "a]".replace(/]/g, "").padStart(1, "a").repeat(80).slice(0, 80);
    expect(validateEnvVarValue(longHex)).toBeUndefined();
    expect(validateEnvVarValue(longAlphanumeric)).toBeUndefined();

    // 83 chars — not divisible by 4, even with base64 chars
    const oddLength = "YWFh".repeat(20) + "YWF";
    expect(oddLength.length).toBe(83);
    expect(validateEnvVarValue(oddLength)).toBeUndefined();

    // Long alphanumeric path or identifier (no +/=/): should not warn
    const longPath = "abcdefghijklmnopqrstuvwxyz0123456789".repeat(3).slice(0, 80);
    expect(validateEnvVarValue(longPath)).toBeUndefined();
  });

  it("flags actual base64-encoded credential data", () => {
    // Valid base64: length 88 (divisible by 4), proper padding, contains +/=
    const realBase64 =
      "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==";
    expect(realBase64.length % 4).toBe(0);
    expect(validateEnvVarValue(realBase64)).toBe("Value looks like base64-encoded credential data");

    // Valid base64 with + and / characters
    const base64WithSpecials = "ABCD+/EF".repeat(10);
    expect(base64WithSpecials.length).toBe(80);
    expect(validateEnvVarValue(base64WithSpecials)).toBe(
      "Value looks like base64-encoded credential data",
    );

    // Valid base64 with single = padding, length 84
    const singlePad = "YWFhYWFh".repeat(10) + "YWE=";
    expect(singlePad.length).toBe(84);
    expect(singlePad.length % 4).toBe(0);
    expect(validateEnvVarValue(singlePad)).toBe("Value looks like base64-encoded credential data");
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
});
