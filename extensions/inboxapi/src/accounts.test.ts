import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { listAccountIds, resolveAccount } from "./accounts.js";

describe("listAccountIds", () => {
  it("returns empty for no config", () => {
    expect(listAccountIds({})).toEqual([]);
    expect(listAccountIds({ channels: {} })).toEqual([]);
  });

  it("returns default when channel section exists", () => {
    const cfg = { channels: { inboxapi: {} } };
    expect(listAccountIds(cfg)).toEqual(["default"]);
  });

  it("returns default + named accounts", () => {
    const cfg = {
      channels: {
        inboxapi: {
          accounts: { prod: { accessToken: "tok1" }, staging: { accessToken: "tok2" } },
        },
      },
    };
    const ids = listAccountIds(cfg);
    expect(ids).toContain("default");
    expect(ids).toContain("prod");
    expect(ids).toContain("staging");
  });
});

describe("resolveAccount", () => {
  const origEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.INBOXAPI_ACCESS_TOKEN;
    delete process.env.INBOXAPI_DOMAIN;
    delete process.env.INBOXAPI_FROM_NAME;
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it("returns defaults for empty config", () => {
    const account = resolveAccount({});
    expect(account.accountId).toBe("default");
    expect(account.enabled).toBe(true);
    expect(account.mcpEndpoint).toBe("https://mcp.inboxapi.ai/mcp");
    expect(account.credentialsPath).toBe("~/.local/inboxapi/credentials.json");
    expect(account.pollIntervalMs).toBe(30_000);
    expect(account.pollBatchSize).toBe(20);
    expect(account.dmPolicy).toBe("allowlist");
    expect(account.allowFrom).toEqual([]);
    expect(account.textChunkLimit).toBe(50_000);
  });

  it("merges base config", () => {
    const cfg = {
      channels: {
        inboxapi: {
          accessToken: "my-token",
          domain: "test.inboxapi.ai",
          fromName: "TestBot",
          pollIntervalMs: 60_000,
        },
      },
    };
    const account = resolveAccount(cfg);
    expect(account.accessToken).toBe("my-token");
    expect(account.domain).toBe("test.inboxapi.ai");
    expect(account.fromName).toBe("TestBot");
    expect(account.pollIntervalMs).toBe(60_000);
  });

  it("account overrides take priority", () => {
    const cfg = {
      channels: {
        inboxapi: {
          accessToken: "base-token",
          domain: "base.inboxapi.ai",
          accounts: {
            prod: {
              accessToken: "prod-token",
              domain: "prod.inboxapi.ai",
            },
          },
        },
      },
    };
    const account = resolveAccount(cfg, "prod");
    expect(account.accountId).toBe("prod");
    expect(account.accessToken).toBe("prod-token");
    expect(account.domain).toBe("prod.inboxapi.ai");
  });

  it("falls back to env vars", () => {
    process.env.INBOXAPI_ACCESS_TOKEN = "env-token";
    process.env.INBOXAPI_DOMAIN = "env.inboxapi.ai";
    const account = resolveAccount({});
    expect(account.accessToken).toBe("env-token");
    expect(account.domain).toBe("env.inboxapi.ai");
  });

  it("parses allowFrom from CSV string", () => {
    const cfg = {
      channels: {
        inboxapi: {
          allowFrom: "alice@example.com, Bob@Example.COM, charlie@test.com",
        },
      },
    };
    const account = resolveAccount(cfg);
    expect(account.allowFrom).toEqual(["alice@example.com", "bob@example.com", "charlie@test.com"]);
  });

  it("parses allowFrom from array", () => {
    const cfg = {
      channels: {
        inboxapi: {
          allowFrom: ["Alice@Example.com", "Bob@Test.com"],
        },
      },
    };
    const account = resolveAccount(cfg);
    expect(account.allowFrom).toEqual(["alice@example.com", "bob@test.com"]);
  });
});
