import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  listCampfireAccountIds,
  resolveCampfireAccount,
  resolveDefaultCampfireAccountId,
} from "./config.js";

describe("campfire config resolution", () => {
  it("returns default when no account config exists", () => {
    const cfg = {} as OpenClawConfig;

    expect(listCampfireAccountIds(cfg)).toEqual(["default"]);
    expect(resolveDefaultCampfireAccountId(cfg)).toBe("default");
  });

  it("resolves top-level account values", () => {
    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://campfire.example.com/",
          botKey: "42-AbCdEf",
          webhookSecret: " shared-secret ",
          allowFrom: [" 42 ", "Alice"],
        },
      },
    } as OpenClawConfig;

    const account = resolveCampfireAccount(cfg);

    expect(account.accountId).toBe("default");
    expect(account.baseUrl).toBe("https://campfire.example.com");
    expect(account.botKey).toBe("42-AbCdEf");
    expect(account.webhookSecret).toBe("shared-secret");
    expect(account.allowFrom).toEqual(["42", "Alice"]);
    expect(account.configured).toBe(true);
    expect(account.webhookPath).toBe("/channels/campfire/webhook/default");
  });

  it("resolves named account overrides with defaultAccount", () => {
    const cfg = {
      channels: {
        campfire: {
          defaultAccount: "alerts",
          baseUrl: "https://campfire.example.com",
          botKey: "top-level-key",
          accounts: {
            alerts: {
              botKey: "alerts-key",
              webhookPath: "/channels/campfire/webhook/custom-alerts",
              allowFrom: ["Bob"],
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveDefaultCampfireAccountId(cfg)).toBe("alerts");

    const account = resolveCampfireAccount(cfg);

    expect(account.accountId).toBe("alerts");
    expect(account.baseUrl).toBe("https://campfire.example.com");
    expect(account.botKey).toBe("alerts-key");
    expect(account.allowFrom).toEqual(["Bob"]);
    expect(account.webhookPath).toBe("/channels/campfire/webhook/custom-alerts");
  });

  it("marks account as unconfigured when baseUrl is missing", () => {
    const cfg = {
      channels: {
        campfire: {
          botKey: "42-AbCdEf",
        },
      },
    } as OpenClawConfig;

    const account = resolveCampfireAccount(cfg);

    expect(account.configured).toBe(false);
    expect(account.baseUrl).toBe("");
  });

  it("marks account as unconfigured when botKey is missing", () => {
    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://campfire.example.com",
        },
      },
    } as OpenClawConfig;

    const account = resolveCampfireAccount(cfg);

    expect(account.configured).toBe(false);
    expect(account.botKey).toBe("");
  });

  it("resolves disabled account", () => {
    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://campfire.example.com",
          botKey: "42-AbCdEf",
          enabled: false,
        },
      },
    } as OpenClawConfig;

    const account = resolveCampfireAccount(cfg);

    expect(account.enabled).toBe(false);
    expect(account.configured).toBe(true);
  });

  it("resolves custom textChunkLimit", () => {
    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://campfire.example.com",
          botKey: "42-AbCdEf",
          textChunkLimit: 2500,
        },
      },
    } as OpenClawConfig;

    const account = resolveCampfireAccount(cfg);

    expect(account.textChunkLimit).toBe(2500);
  });

  it("falls back to default textChunkLimit for non-positive values", () => {
    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://campfire.example.com",
          botKey: "42-AbCdEf",
          textChunkLimit: 0,
        },
      },
    } as OpenClawConfig;

    const account = resolveCampfireAccount(cfg);

    expect(account.textChunkLimit).toBe(4000);
  });

  it("lists multiple account IDs", () => {
    const cfg = {
      channels: {
        campfire: {
          accounts: {
            support: { botKey: "1-abc" },
            alerts: { botKey: "2-def" },
          },
        },
      },
    } as OpenClawConfig;

    const ids = listCampfireAccountIds(cfg);

    expect(ids).toEqual(["alerts", "support"]);
  });
});
