/**
 * Tests for DingTalk account resolution.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  createMockClawdbotConfig,
  createEnvBasedConfig,
  createMultiAccountConfig,
} from "../test/fixtures/configs.js";
import {
  resolveDingTalkAccount,
  listDingTalkAccountIds,
  resolveDefaultDingTalkAccountId,
  isDingTalkAccountConfigured,
} from "./accounts.js";

describe("resolveDingTalkAccount", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("resolves basic account from config", () => {
    const cfg = createMockClawdbotConfig();
    const account = resolveDingTalkAccount({ cfg });

    expect(account.accountId).toBe("default");
    expect(account.clientId).toBe("test-client-id");
    expect(account.clientSecret).toBe("test-client-secret");
    expect(account.credentialSource).toBe("config");
    expect(account.enabled).toBe(true);
  });

  it("resolves account from environment variables", () => {
    process.env.DINGTALK_CLIENT_ID = "env-client-id";
    process.env.DINGTALK_CLIENT_SECRET = "env-client-secret";

    const cfg = createEnvBasedConfig();
    const account = resolveDingTalkAccount({ cfg });

    expect(account.clientId).toBe("env-client-id");
    expect(account.clientSecret).toBe("env-client-secret");
    expect(account.credentialSource).toBe("env");
  });

  it("resolves named account from multi-account config", () => {
    const cfg = createMultiAccountConfig();
    const account = resolveDingTalkAccount({ cfg, accountId: "team1" });

    expect(account.accountId).toBe("team1");
    expect(account.name).toBe("Team 1 Bot");
    expect(account.clientId).toBe("team1-client-id");
    expect(account.clientSecret).toBe("team1-client-secret");
  });

  it("inherits settings from base when account overrides not specified", () => {
    const cfg = createMultiAccountConfig();
    const account = resolveDingTalkAccount({ cfg, accountId: "team1" });

    // Should inherit replyMode from base (default is "text")
    expect(account.replyMode).toBe("text");
  });

  it("uses account-specific overrides when provided", () => {
    const cfg = createMultiAccountConfig();
    const account = resolveDingTalkAccount({ cfg, accountId: "team2" });

    // team2 has its own replyMode
    expect(account.replyMode).toBe("markdown");
  });

  it("applies default values", () => {
    const cfg = createMockClawdbotConfig();
    const account = resolveDingTalkAccount({ cfg });

    expect(account.apiBase).toBe("https://api.dingtalk.com");
    expect(account.openPath).toBe("/v1.0/gateway/connections/open");
    expect(account.replyMode).toBe("text");
    expect(account.maxChars).toBe(1800);
    expect(account.tableMode).toBe("code");
    expect(account.allowFrom).toEqual([]);
    expect(account.showToolStatus).toBe(false);
    expect(account.showToolResult).toBe(false);
    expect(account.isolateContextPerUserInGroup).toBe(false);
    expect(account.thinking).toBe("off");
  });

  it("resolves isolateContextPerUserInGroup from config", () => {
    const cfg = createMockClawdbotConfig({
      isolateContextPerUserInGroup: true,
    });
    const account = resolveDingTalkAccount({ cfg });

    expect(account.isolateContextPerUserInGroup).toBe(true);
  });

  it("merges coalesce config with defaults", () => {
    const cfg = createMockClawdbotConfig({
      coalesce: {
        enabled: true,
        minChars: 500,
        maxChars: 1500,
        idleMs: 800,
      },
    });
    const account = resolveDingTalkAccount({ cfg });

    expect(account.coalesce.enabled).toBe(true);
    expect(account.coalesce.minChars).toBe(500);
    expect(account.coalesce.maxChars).toBe(1500);
    expect(account.coalesce.idleMs).toBe(800);
  });

  it("resolves allowFrom array", () => {
    const cfg = createMockClawdbotConfig({
      allowFrom: ["user1", "user2", "user3"],
    });
    const account = resolveDingTalkAccount({ cfg });

    expect(account.allowFrom).toEqual(["user1", "user2", "user3"]);
  });

  it("handles missing dingtalk section gracefully", () => {
    const cfg = { channels: {} };
    const account = resolveDingTalkAccount({ cfg });

    expect(account.clientId).toBe("");
    expect(account.clientSecret).toBe("");
    expect(account.credentialSource).toBe("none");
  });

  it("prioritizes config over environment variables", () => {
    process.env.DINGTALK_CLIENT_ID = "env-id";
    process.env.DINGTALK_CLIENT_SECRET = "env-secret";

    const cfg = createMockClawdbotConfig();
    const account = resolveDingTalkAccount({ cfg });

    expect(account.clientId).toBe("test-client-id");
    expect(account.credentialSource).toBe("config");
  });
});

describe("listDingTalkAccountIds", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it("returns default account when base credentials exist", () => {
    const cfg = createMockClawdbotConfig();
    const ids = listDingTalkAccountIds(cfg);

    expect(ids).toContain("default");
  });

  it("returns all named accounts", () => {
    const cfg = createMultiAccountConfig();
    const ids = listDingTalkAccountIds(cfg);

    expect(ids).toContain("default");
    expect(ids).toContain("team1");
    expect(ids).toContain("team2");
  });

  it("returns empty array when no dingtalk section", () => {
    const cfg = { channels: {} };
    const ids = listDingTalkAccountIds(cfg);

    expect(ids).toEqual([]);
  });

  it("includes default when env credentials exist", () => {
    process.env.DINGTALK_CLIENT_ID = "env-id";

    const cfg = createEnvBasedConfig();
    const ids = listDingTalkAccountIds(cfg);

    expect(ids).toContain("default");
  });
});

describe("resolveDefaultDingTalkAccountId", () => {
  it("returns first account ID when accounts exist", () => {
    const cfg = createMockClawdbotConfig();
    const defaultId = resolveDefaultDingTalkAccountId(cfg);

    expect(defaultId).toBe("default");
  });

  it("returns default when no accounts configured", () => {
    const cfg = { channels: {} };
    const defaultId = resolveDefaultDingTalkAccountId(cfg);

    expect(defaultId).toBe("default");
  });
});

describe("isDingTalkAccountConfigured", () => {
  it("returns true when both clientId and clientSecret are set", () => {
    const account = resolveDingTalkAccount({
      cfg: createMockClawdbotConfig(),
    });

    expect(isDingTalkAccountConfigured(account)).toBe(true);
  });

  it("returns false when clientId is empty", () => {
    const account = {
      ...resolveDingTalkAccount({ cfg: createMockClawdbotConfig() }),
      clientId: "",
    };

    expect(isDingTalkAccountConfigured(account)).toBe(false);
  });

  it("returns false when clientSecret is empty", () => {
    const account = {
      ...resolveDingTalkAccount({ cfg: createMockClawdbotConfig() }),
      clientSecret: "",
    };

    expect(isDingTalkAccountConfigured(account)).toBe(false);
  });

  it("returns false when clientId is whitespace only", () => {
    const account = {
      ...resolveDingTalkAccount({ cfg: createMockClawdbotConfig() }),
      clientId: "   ",
    };

    expect(isDingTalkAccountConfigured(account)).toBe(false);
  });
});
