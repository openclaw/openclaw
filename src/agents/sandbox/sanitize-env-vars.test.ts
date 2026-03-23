import { describe, expect, it } from "vitest";
import { sanitizeEnvVars } from "./sanitize-env-vars.js";

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

  it("rescues blocked keys listed in allowedSensitiveKeys", () => {
    const result = sanitizeEnvVars(
      {
        NODE_ENV: "test",
        OPENAI_API_KEY: "sk-live-xxx", // pragma: allowlist secret
        MY_CUSTOM_TOKEN: "tok-yyy",
        GITHUB_TOKEN: "gh-token", // pragma: allowlist secret
      },
      {
        allowedSensitiveKeys: new Set(["OPENAI_API_KEY", "MY_CUSTOM_TOKEN"]),
      },
    );

    expect(result.allowed).toEqual({
      NODE_ENV: "test",
      OPENAI_API_KEY: "sk-live-xxx",
      MY_CUSTOM_TOKEN: "tok-yyy",
    });
    // GITHUB_TOKEN is NOT in allowedSensitiveKeys, so it stays blocked
    expect(result.blocked).toEqual(["GITHUB_TOKEN"]);
  });

  it("still blocks null-byte values even when key is in allowedSensitiveKeys", () => {
    const result = sanitizeEnvVars(
      {
        MY_TOKEN: "valid\0injected",
      },
      {
        allowedSensitiveKeys: new Set(["MY_TOKEN"]),
      },
    );

    expect(result.allowed).toEqual({});
    expect(result.blocked).toEqual(["MY_TOKEN"]);
  });

  it("warns on suspicious values for rescued keys", () => {
    const base64Like =
      "YWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYQ==";
    const result = sanitizeEnvVars(
      {
        MY_SECRET: base64Like,
      },
      {
        allowedSensitiveKeys: new Set(["MY_SECRET"]),
      },
    );

    expect(result.allowed).toEqual({ MY_SECRET: base64Like });
    expect(result.blocked).toEqual([]);
    expect(result.warnings).toContain("MY_SECRET: Value looks like base64-encoded credential data");
  });

  it("never rescues runtime-dangerous keys even if listed in allowedSensitiveKeys", () => {
    // OPENCLAW_GATEWAY_TOKEN matches the suffix block pattern AND is always-blocked.
    // LD_PRELOAD_SECRET matches the suffix block pattern AND isDangerousHostEnvVarName
    // (LD_ prefix).  Both must stay blocked even when listed in allowedSensitiveKeys.
    const result = sanitizeEnvVars(
      {
        OPENCLAW_GATEWAY_TOKEN: "gw-tok", // pragma: allowlist secret
        LD_PRELOAD_SECRET: "/evil.so",
        OPENAI_API_KEY: "sk-live-xxx", // pragma: allowlist secret
      },
      {
        allowedSensitiveKeys: new Set([
          "OPENCLAW_GATEWAY_TOKEN",
          "LD_PRELOAD_SECRET",
          "OPENAI_API_KEY",
        ]),
      },
    );

    // OPENCLAW_GATEWAY_TOKEN and LD_PRELOAD_SECRET must stay blocked
    expect(result.blocked).toEqual(
      expect.arrayContaining(["OPENCLAW_GATEWAY_TOKEN", "LD_PRELOAD_SECRET"]),
    );
    // Only OPENAI_API_KEY should be rescued
    expect(result.allowed).toEqual({ OPENAI_API_KEY: "sk-live-xxx" });
  });

  it("blocks NODE_OPTIONS via custom block pattern even with allowedSensitiveKeys", () => {
    // NODE_OPTIONS doesn't match default BLOCKED_ENV_VAR_PATTERNS (no _TOKEN/_KEY suffix),
    // but if added via customBlockedPatterns, the always-blocked guard prevents rescue.
    const result = sanitizeEnvVars(
      {
        NODE_OPTIONS: "--inspect",
        OPENAI_API_KEY: "sk-live-xxx", // pragma: allowlist secret
      },
      {
        customBlockedPatterns: [/^NODE_OPTIONS$/i],
        allowedSensitiveKeys: new Set(["NODE_OPTIONS", "OPENAI_API_KEY"]),
      },
    );

    expect(result.blocked).toContain("NODE_OPTIONS");
    expect(result.allowed).toEqual({ OPENAI_API_KEY: "sk-live-xxx" });
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
