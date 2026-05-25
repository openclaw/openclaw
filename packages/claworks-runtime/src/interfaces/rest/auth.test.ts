import { describe, expect, it } from "vitest";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { checkClaworksApiAuth, hashApiKey, resolveAuthContext } from "./auth.js";

function fakeRuntime(apiKey?: string, extraKeys?: string[]): ClaworksRuntime {
  return {
    config: {
      api: {
        ...(apiKey ? { api_key: apiKey } : {}),
        ...(extraKeys ? { api_keys: extraKeys } : {}),
      },
    },
  } as ClaworksRuntime;
}

describe("checkClaworksApiAuth", () => {
  it("allows when no api_key configured", () => {
    const req = { headers: {} } as import("node:http").IncomingMessage;
    expect(checkClaworksApiAuth(req, fakeRuntime())).toBe(true);
  });

  it("requires Bearer token when api_key set", () => {
    const req = {
      headers: { authorization: "Bearer secret" },
    } as import("node:http").IncomingMessage;
    expect(checkClaworksApiAuth(req, fakeRuntime("secret"))).toBe(true);
    expect(checkClaworksApiAuth(req, fakeRuntime("other"))).toBe(false);
  });
});

describe("resolveAuthContext channel_user header", () => {
  it("uses X-ClaWorks-Channel-User when Bearer matches", () => {
    const req = {
      headers: {
        authorization: "Bearer secret",
        "x-claworks-channel-user": "feishu:user-001",
      },
    } as import("node:http").IncomingMessage;
    const ctx = resolveAuthContext(req, fakeRuntime("secret"));
    expect(ctx.authenticated).toBe(true);
    expect(ctx.subjectType).toBe("channel_user");
    expect(ctx.subjectId).toBe("feishu:user-001");
  });

  it("denies when require_api_key set but api_key missing", () => {
    const req = { headers: {} } as import("node:http").IncomingMessage;
    const rt = {
      config: { api: { require_api_key: true } },
    } as ClaworksRuntime;
    const denied = resolveAuthContext(req, rt);
    expect(denied.authenticated).toBe(false);
  });

  it("uses channel_user in local dev when header present", () => {
    const req = {
      headers: { "x-claworks-channel-user": "feishu:owner" },
    } as import("node:http").IncomingMessage;
    const ctx = resolveAuthContext(req, fakeRuntime());
    expect(ctx.subjectType).toBe("channel_user");
    expect(ctx.subjectId).toBe("feishu:owner");
  });
});

describe("multi-key support (key rotation)", () => {
  it("accepts secondary key from api_keys list", () => {
    const rt = fakeRuntime("primary-key", ["rotation-key-1", "rotation-key-2"]);
    const req = (token: string) =>
      ({ headers: { authorization: `Bearer ${token}` } }) as import("node:http").IncomingMessage;
    expect(resolveAuthContext(req("primary-key"), rt).authenticated).toBe(true);
    expect(resolveAuthContext(req("rotation-key-1"), rt).authenticated).toBe(true);
    expect(resolveAuthContext(req("rotation-key-2"), rt).authenticated).toBe(true);
    expect(resolveAuthContext(req("stale-key"), rt).authenticated).toBe(false);
  });

  it("works when only api_keys list is set (no primary api_key)", () => {
    const rt = fakeRuntime(undefined, ["only-key"]);
    const req = (token: string) =>
      ({ headers: { authorization: `Bearer ${token}` } }) as import("node:http").IncomingMessage;
    expect(resolveAuthContext(req("only-key"), rt).authenticated).toBe(true);
    expect(resolveAuthContext(req("wrong"), rt).authenticated).toBe(false);
  });

  it("ignores duplicate keys between api_key and api_keys", () => {
    const rt = fakeRuntime("shared-key", ["shared-key", "extra-key"]);
    const req = (token: string) =>
      ({ headers: { authorization: `Bearer ${token}` } }) as import("node:http").IncomingMessage;
    expect(resolveAuthContext(req("shared-key"), rt).authenticated).toBe(true);
    expect(resolveAuthContext(req("extra-key"), rt).authenticated).toBe(true);
  });

  it("accepts 32-char base64url plaintext keys from secure init", () => {
    const plainKey = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
    expect(plainKey.length).toBe(32);
    const rt = fakeRuntime(plainKey);
    const req = {
      headers: { authorization: `Bearer ${plainKey}` },
    } as import("node:http").IncomingMessage;
    expect(resolveAuthContext(req, rt).authenticated).toBe(true);
  });

  it("accepts SHA-256 hex stored keys", () => {
    const token = "my-secret-token";
    const stored = hashApiKey(token);
    const rt = fakeRuntime(stored);
    const req = {
      headers: { authorization: `Bearer ${token}` },
    } as import("node:http").IncomingMessage;
    expect(resolveAuthContext(req, rt).authenticated).toBe(true);
  });
});
