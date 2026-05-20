import { describe, expect, it } from "vitest";
import type { ClaworksRuntime } from "../../claworks/runtime.js";
import { checkClaworksApiAuth, resolveAuthContext } from "./auth.js";

function fakeRuntime(apiKey?: string): ClaworksRuntime {
  return {
    config: { api: apiKey ? { api_key: apiKey } : {} },
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

  it("uses channel_user in local dev when header present", () => {
    const req = {
      headers: { "x-claworks-channel-user": "feishu:owner" },
    } as import("node:http").IncomingMessage;
    const ctx = resolveAuthContext(req, fakeRuntime());
    expect(ctx.subjectType).toBe("channel_user");
    expect(ctx.subjectId).toBe("feishu:owner");
  });
});
