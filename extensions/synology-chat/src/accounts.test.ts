import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  listAccountIds,
  resolveAccount,
  parseChannelTokensFromEnv,
  parseChannelWebhooksFromEnv,
} from "./accounts.js";

// Save and restore env vars
const originalEnv = { ...process.env };

beforeEach(() => {
  // Clean synology-related env vars before each test
  delete process.env.SYNOLOGY_CHAT_TOKEN;
  delete process.env.SYNOLOGY_CHAT_INCOMING_URL;
  delete process.env.SYNOLOGY_NAS_HOST;
  delete process.env.SYNOLOGY_ALLOWED_USER_IDS;
  delete process.env.SYNOLOGY_RATE_LIMIT;
  delete process.env.OPENCLAW_BOT_NAME;
});

describe("listAccountIds", () => {
  it("returns empty array when no channel config", () => {
    expect(listAccountIds({})).toEqual([]);
    expect(listAccountIds({ channels: {} })).toEqual([]);
  });

  it("returns ['default'] when base config has token", () => {
    const cfg = { channels: { "synology-chat": { token: "abc" } } };
    expect(listAccountIds(cfg)).toEqual(["default"]);
  });

  it("returns ['default'] when env var has token", () => {
    process.env.SYNOLOGY_CHAT_TOKEN = "env-token";
    const cfg = { channels: { "synology-chat": {} } };
    expect(listAccountIds(cfg)).toEqual(["default"]);
  });

  it("returns named accounts", () => {
    const cfg = {
      channels: {
        "synology-chat": {
          accounts: { work: { token: "t1" }, home: { token: "t2" } },
        },
      },
    };
    const ids = listAccountIds(cfg);
    expect(ids).toContain("work");
    expect(ids).toContain("home");
  });

  it("returns default + named accounts", () => {
    const cfg = {
      channels: {
        "synology-chat": {
          token: "base-token",
          accounts: { work: { token: "t1" } },
        },
      },
    };
    const ids = listAccountIds(cfg);
    expect(ids).toContain("default");
    expect(ids).toContain("work");
  });
});

describe("resolveAccount", () => {
  it("returns full defaults for empty config", () => {
    const cfg = { channels: { "synology-chat": {} } };
    const account = resolveAccount(cfg, "default");
    expect(account.accountId).toBe("default");
    expect(account.enabled).toBe(true);
    expect(account.webhookPath).toBe("/webhook/synology");
    expect(account.dmPolicy).toBe("allowlist");
    expect(account.rateLimitPerMinute).toBe(30);
    expect(account.botName).toBe("OpenClaw");
  });

  it("uses env var fallbacks", () => {
    process.env.SYNOLOGY_CHAT_TOKEN = "env-tok";
    process.env.SYNOLOGY_CHAT_INCOMING_URL = "https://nas/incoming";
    process.env.SYNOLOGY_NAS_HOST = "192.0.2.1";
    process.env.OPENCLAW_BOT_NAME = "TestBot";

    const cfg = { channels: { "synology-chat": {} } };
    const account = resolveAccount(cfg);
    expect(account.token).toBe("env-tok");
    expect(account.incomingUrl).toBe("https://nas/incoming");
    expect(account.nasHost).toBe("192.0.2.1");
    expect(account.botName).toBe("TestBot");
  });

  it("config overrides env vars", () => {
    process.env.SYNOLOGY_CHAT_TOKEN = "env-tok";
    const cfg = {
      channels: { "synology-chat": { token: "config-tok" } },
    };
    const account = resolveAccount(cfg);
    expect(account.token).toBe("config-tok");
  });

  it("account override takes priority over base config", () => {
    const cfg = {
      channels: {
        "synology-chat": {
          token: "base-tok",
          botName: "BaseName",
          accounts: {
            work: { token: "work-tok", botName: "WorkBot" },
          },
        },
      },
    };
    const account = resolveAccount(cfg, "work");
    expect(account.token).toBe("work-tok");
    expect(account.botName).toBe("WorkBot");
  });

  it("parses comma-separated allowedUserIds string", () => {
    const cfg = {
      channels: {
        "synology-chat": { allowedUserIds: "user1, user2, user3" },
      },
    };
    const account = resolveAccount(cfg);
    expect(account.allowedUserIds).toEqual(["user1", "user2", "user3"]);
  });

  it("handles allowedUserIds as array", () => {
    const cfg = {
      channels: {
        "synology-chat": { allowedUserIds: ["u1", "u2"] },
      },
    };
    const account = resolveAccount(cfg);
    expect(account.allowedUserIds).toEqual(["u1", "u2"]);
  });

  it("respects SYNOLOGY_RATE_LIMIT=0 instead of defaulting to 30", () => {
    process.env.SYNOLOGY_RATE_LIMIT = "0";
    const cfg = { channels: { "synology-chat": {} } };
    const account = resolveAccount(cfg);
    expect(account.rateLimitPerMinute).toBe(0);
  });

  it("falls back to 30 for malformed SYNOLOGY_RATE_LIMIT values", () => {
    process.env.SYNOLOGY_RATE_LIMIT = "0abc";
    const cfg = { channels: { "synology-chat": {} } };
    const account = resolveAccount(cfg);
    expect(account.rateLimitPerMinute).toBe(30);
  });

  it("resolves group fields with defaults", () => {
    const cfg = { channels: { "synology-chat": {} } };
    const account = resolveAccount(cfg);
    expect(account.channelTokens).toEqual({});
    expect(account.channelWebhooks).toEqual({});
    expect(account.groupPolicy).toBe("disabled");
    expect(account.groupAllowFrom).toEqual([]);
  });

  it("resolves channelTokens and channelWebhooks from config", () => {
    const cfg = {
      channels: {
        "synology-chat": {
          channelTokens: { "42": "tok-42" },
          channelWebhooks: { "42": "https://nas/channel-42" },
          groupPolicy: "open",
          groupAllowFrom: "1,2,3",
        },
      },
    };
    const account = resolveAccount(cfg);
    expect(account.channelTokens).toEqual({ "42": "tok-42" });
    expect(account.channelWebhooks).toEqual({ "42": "https://nas/channel-42" });
    expect(account.groupPolicy).toBe("open");
    expect(account.groupAllowFrom).toEqual(["1", "2", "3"]);
  });

  it("merges channelTokens from env and config (config wins)", () => {
    process.env.SYNOLOGY_CHANNEL_TOKEN_10 = "env-tok-10";
    process.env.SYNOLOGY_CHANNEL_TOKEN_42 = "env-tok-42";
    const cfg = {
      channels: {
        "synology-chat": {
          channelTokens: { "42": "config-tok-42" },
        },
      },
    };
    const account = resolveAccount(cfg);
    expect(account.channelTokens["10"]).toBe("env-tok-10");
    expect(account.channelTokens["42"]).toBe("config-tok-42"); // config wins
    delete process.env.SYNOLOGY_CHANNEL_TOKEN_10;
    delete process.env.SYNOLOGY_CHANNEL_TOKEN_42;
  });
});

describe("parseChannelTokensFromEnv", () => {
  it("parses SYNOLOGY_CHANNEL_TOKEN_* env vars", () => {
    process.env.SYNOLOGY_CHANNEL_TOKEN_42 = "tok42";
    process.env.SYNOLOGY_CHANNEL_TOKEN_99 = "tok99";
    const result = parseChannelTokensFromEnv();
    expect(result["42"]).toBe("tok42");
    expect(result["99"]).toBe("tok99");
    delete process.env.SYNOLOGY_CHANNEL_TOKEN_42;
    delete process.env.SYNOLOGY_CHANNEL_TOKEN_99;
  });

  it("returns empty object when no matching env vars", () => {
    expect(parseChannelTokensFromEnv()).toEqual({});
  });
});

describe("parseChannelWebhooksFromEnv", () => {
  it("parses SYNOLOGY_CHANNEL_WEBHOOK_* env vars", () => {
    process.env.SYNOLOGY_CHANNEL_WEBHOOK_42 = "https://nas/42";
    const result = parseChannelWebhooksFromEnv();
    expect(result["42"]).toBe("https://nas/42");
    delete process.env.SYNOLOGY_CHANNEL_WEBHOOK_42;
  });
});
