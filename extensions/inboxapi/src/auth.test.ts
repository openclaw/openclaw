import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { resolveAccessToken, resolveDomain } from "./auth.js";
import type { ResolvedInboxApiAccount } from "./types.js";

function makeAccount(overrides: Partial<ResolvedInboxApiAccount> = {}): ResolvedInboxApiAccount {
  return {
    accountId: "default",
    enabled: true,
    mcpEndpoint: "https://mcp.inboxapi.ai/mcp",
    credentialsPath: "/nonexistent/credentials.json",
    accessToken: "",
    domain: "",
    fromName: "",
    pollIntervalMs: 30_000,
    pollBatchSize: 20,
    dmPolicy: "allowlist",
    allowFrom: [],
    textChunkLimit: 50_000,
    ...overrides,
  };
}

describe("resolveAccessToken", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.INBOXAPI_ACCESS_TOKEN;
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("uses config accessToken first", async () => {
    const account = makeAccount({ accessToken: "config-token" });
    expect(await resolveAccessToken(account)).toBe("config-token");
  });

  it("falls back to env var", async () => {
    process.env.INBOXAPI_ACCESS_TOKEN = "env-token";
    const account = makeAccount();
    expect(await resolveAccessToken(account)).toBe("env-token");
  });

  it("returns empty string when no credentials", async () => {
    const account = makeAccount();
    expect(await resolveAccessToken(account)).toBe("");
  });
});

describe("resolveDomain", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.INBOXAPI_DOMAIN;
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("uses config domain first", async () => {
    const account = makeAccount({ domain: "test.inboxapi.ai" });
    expect(await resolveDomain(account)).toBe("test.inboxapi.ai");
  });

  it("falls back to env var", async () => {
    process.env.INBOXAPI_DOMAIN = "env.inboxapi.ai";
    const account = makeAccount();
    expect(await resolveDomain(account)).toBe("env.inboxapi.ai");
  });

  it("returns empty string when no domain", async () => {
    const account = makeAccount();
    expect(await resolveDomain(account)).toBe("");
  });
});
