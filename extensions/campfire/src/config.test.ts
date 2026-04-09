import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import {
  campfireChannelConfigSchema,
  campfireConfigSchema,
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

  it("matches defaultAccount case-insensitively", () => {
    const cfg = {
      channels: {
        campfire: {
          defaultAccount: "support",
          accounts: {
            Support: {
              baseUrl: "https://campfire.example.com",
              botKey: "support-key",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(resolveDefaultCampfireAccountId(cfg)).toBe("Support");
    expect(resolveCampfireAccount(cfg).botKey).toBe("support-key");
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

  it("does not inherit top-level webhookPath into named accounts", () => {
    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://campfire.example.com",
          botKey: "42-AbCdEf",
          webhookPath: "/channels/campfire/webhook/shared",
          accounts: {
            support: {
              botKey: "support-key",
            },
          },
        },
      },
    } as OpenClawConfig;

    const defaultAccount = resolveCampfireAccount(cfg, "default");
    const supportAccount = resolveCampfireAccount(cfg, "support");

    expect(defaultAccount.webhookPath).toBe("/channels/campfire/webhook/shared");
    expect(supportAccount.webhookPath).toBe("/channels/campfire/webhook/support");
  });

  it("resolves named accounts case-insensitively", () => {
    const cfg = {
      channels: {
        campfire: {
          baseUrl: "https://campfire.example.com",
          botKey: "top-level-key",
          accounts: {
            Support: {
              botKey: "support-key",
              webhookPath: "/channels/campfire/webhook/support-room",
            },
          },
        },
      },
    } as OpenClawConfig;

    const account = resolveCampfireAccount(cfg, "support");

    expect(account.botKey).toBe("support-key");
    expect(account.webhookPath).toBe("/channels/campfire/webhook/support-room");
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

  it("marks botKey fields as sensitive in config schema ui hints", () => {
    expect(campfireChannelConfigSchema.uiHints?.botKey?.sensitive).toBe(true);
    expect(campfireChannelConfigSchema.uiHints?.["accounts.*.botKey"]?.sensitive).toBe(true);
  });

  it("rejects bare Basecamp shard URLs in schema", () => {
    const topLevelResult = campfireConfigSchema.safeParse({
      baseUrl: "https://3.basecamp.com",
      botKey: "42-AbCdEf",
    });
    const accountResult = campfireConfigSchema.safeParse({
      accounts: {
        support: {
          baseUrl: "https://3.basecamp.com",
          botKey: "99-ZyXwVu",
        },
      },
    });

    expect(topLevelResult.success).toBe(false);
    expect(accountResult.success).toBe(false);
  });

  it("rejects non-http(s) baseUrl protocols in schema", () => {
    const topLevelResult = campfireConfigSchema.safeParse({
      baseUrl: "ftp://campfire.example.com/1234567",
      botKey: "42-AbCdEf",
    });
    const accountResult = campfireConfigSchema.safeParse({
      accounts: {
        support: {
          baseUrl: "file:///tmp/campfire-room",
          botKey: "99-ZyXwVu",
        },
      },
    });

    expect(topLevelResult.success).toBe(false);
    expect(accountResult.success).toBe(false);
  });
});
