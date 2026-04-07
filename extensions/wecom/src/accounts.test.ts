import { describe, expect, test } from "vitest";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";

// Import the functions under test
import {
  listWeComAccountIds,
  hasMultiAccounts,
  resolveWeComAccountMulti,
} from "./accounts.js";

const CHANNEL_ID = "wecom";

function buildConfig(wecomConfig: Record<string, unknown>): OpenClawConfig {
  return {
    channels: {
      [CHANNEL_ID]: wecomConfig,
    },
  } as unknown as OpenClawConfig;
}

describe("listWeComAccountIds", () => {
  test("returns default account when no accounts field", () => {
    const cfg = buildConfig({ enabled: true, botId: "bot1", secret: "s1" });
    const ids = listWeComAccountIds(cfg);
    expect(ids).toEqual(["default"]);
  });

  test("returns sorted account IDs from accounts field", () => {
    const cfg = buildConfig({
      enabled: true,
      accounts: {
        charlie: { botId: "b3", secret: "s3" },
        alpha: { botId: "b1", secret: "s1" },
        bravo: { botId: "b2", secret: "s2" },
      },
    });
    const ids = listWeComAccountIds(cfg);
    expect(ids).toEqual(["alpha", "bravo", "charlie"]);
  });

  test("returns default when accounts is empty object", () => {
    const cfg = buildConfig({ enabled: true, accounts: {} });
    const ids = listWeComAccountIds(cfg);
    expect(ids).toEqual(["default"]);
  });
});

describe("hasMultiAccounts", () => {
  test("returns false when no accounts field", () => {
    const cfg = buildConfig({ enabled: true });
    expect(hasMultiAccounts(cfg)).toBe(false);
  });

  test("returns true when accounts field has entries", () => {
    const cfg = buildConfig({
      enabled: true,
      accounts: { bot2: { botId: "b2", secret: "s2" } },
    });
    expect(hasMultiAccounts(cfg)).toBe(true);
  });
});

describe("resolveWeComAccountMulti", () => {
  test("resolves single-account config with default ID", () => {
    const cfg = buildConfig({
      enabled: true,
      botId: "mybot",
      secret: "mysecret",
      name: "Test Bot",
    });
    const account = resolveWeComAccountMulti({ cfg });
    expect(account.accountId).toBe("default");
    expect(account.botId).toBe("mybot");
    expect(account.secret).toBe("mysecret");
    expect(account.name).toBe("Test Bot");
    expect(account.enabled).toBe(true);
  });

  test("resolves multi-account config by accountId", () => {
    const cfg = buildConfig({
      enabled: true,
      botId: "default-bot",
      secret: "default-secret",
      accounts: {
        bot2: {
          enabled: true,
          botId: "bot2-id",
          secret: "bot2-secret",
          name: "Bot Two",
        },
      },
    });
    const account = resolveWeComAccountMulti({ cfg, accountId: "bot2" });
    expect(account.accountId).toBe("bot2");
    expect(account.botId).toBe("bot2-id");
    expect(account.secret).toBe("bot2-secret");
  });

  test("inherits top-level fields when account field is missing", () => {
    const cfg = buildConfig({
      enabled: true,
      botId: "top-bot",
      secret: "top-secret",
      websocketUrl: "wss://custom.example.com",
      accounts: {
        child: {
          botId: "child-bot",
          secret: "child-secret",
        },
      },
    });
    const account = resolveWeComAccountMulti({ cfg, accountId: "child" });
    expect(account.botId).toBe("child-bot");
    // websocketUrl should fall through from top-level or use default
    expect(account.websocketUrl).toBeTruthy();
  });

  test("disabled account has enabled=false", () => {
    const cfg = buildConfig({
      enabled: true,
      accounts: {
        disabled_bot: {
          enabled: false,
          botId: "b1",
          secret: "s1",
        },
      },
    });
    const account = resolveWeComAccountMulti({ cfg, accountId: "disabled_bot" });
    expect(account.enabled).toBe(false);
  });

  test("defaults to empty botId/secret when not provided", () => {
    const cfg = buildConfig({ enabled: true });
    const account = resolveWeComAccountMulti({ cfg });
    expect(account.botId).toBe("");
    expect(account.secret).toBe("");
  });
});
