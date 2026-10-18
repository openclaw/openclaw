// Feishu tests cover tool account plugin behavior.
import { describe, expect, it } from "vitest";
import { resolveFeishuToolAccount } from "./tool-account.js";

describe("resolveFeishuToolAccount", () => {
  const requiredTool = { family: "wiki", label: "Wiki" } as const;
  const cfg = {
    channels: {
      feishu: {
        enabled: true,
        defaultAccount: "ops",
        appId: "base-app-id",
        appSecret: "base-app-secret", // pragma: allowlist secret
        accounts: {
          ops: {
            enabled: true,
            appId: "ops-app-id",
            appSecret: "ops-app-secret", // pragma: allowlist secret
          },
          work: {
            enabled: true,
            appId: "work-app-id",
            appSecret: "work-app-secret", // pragma: allowlist secret
          },
          disabled: {
            enabled: false,
            appId: "disabled-app-id",
            appSecret: "disabled-app-secret", // pragma: allowlist secret
          },
        },
      },
    },
  };

  function resolveAccount(overrides: Partial<Parameters<typeof resolveFeishuToolAccount>[0]> = {}) {
    return resolveFeishuToolAccount({ cfg, requiredTool, ...overrides });
  }

  it("prefers the active contextual account over configured defaultAccount", () => {
    expect(resolveAccount({ defaultAccountId: "work" }).accountId).toBe("work");
  });

  it("matches a mixed-case configured contextual account before fallback", () => {
    expect(() =>
      resolveFeishuToolAccount({
        cfg: {
          channels: {
            feishu: {
              enabled: true,
              accounts: {
                Ops: {
                  enabled: true,
                  appId: "ops-app-id",
                  appSecret: "ops-app-secret", // pragma: allowlist secret
                  tools: { wiki: false },
                },
                admin: {
                  enabled: true,
                  appId: "admin-app-id",
                  appSecret: "admin-app-secret", // pragma: allowlist secret
                  tools: { wiki: true },
                },
              },
            },
          },
        },
        defaultAccountId: "ops",
        requiredTool,
      }),
    ).toThrow('Feishu Wiki tools are disabled for account "ops"');
  });

  it("keeps a mixed-case restricted configured default fail-closed", () => {
    expect(() =>
      resolveFeishuToolAccount({
        cfg: {
          channels: {
            feishu: {
              enabled: true,
              defaultAccount: "Ops",
              accounts: {
                Ops: {
                  enabled: true,
                  appId: "ops-app-id",
                  appSecret: "ops-app-secret", // pragma: allowlist secret
                  tools: { wiki: false },
                },
                admin: {
                  enabled: true,
                  appId: "admin-app-id",
                  appSecret: "admin-app-secret", // pragma: allowlist secret
                  tools: { wiki: true },
                },
              },
            },
          },
        },
        defaultAccountId: "ops",
        requiredTool,
      }),
    ).toThrow('Feishu Wiki tools are disabled for account "ops"');
  });

  it("falls back to configured defaultAccount when there is no contextual account", () => {
    expect(resolveAccount().accountId).toBe("ops");
  });

  it("skips a disabled configured defaultAccount", () => {
    const resolved = resolveAccount({
      cfg: {
        channels: {
          feishu: {
            ...cfg.channels.feishu,
            defaultAccount: "disabled",
          },
        },
      },
    });

    expect(resolved.accountId).toBe("default");
    expect(resolved.appId).toBe("base-app-id");
  });

  it("rejects tool account resolution when the channel is disabled", () => {
    expect(() =>
      resolveAccount({
        cfg: {
          channels: {
            feishu: {
              ...cfg.channels.feishu,
              enabled: false,
            },
          },
        },
      }),
    ).toThrow("No usable Feishu account has Wiki tools enabled");
  });

  it("allows an explicit configured account", () => {
    expect(resolveAccount({ executeParams: { accountId: "WORK" } }).accountId).toBe("work");
  });

  it("allows the explicit unlisted default backed by top-level credentials", () => {
    const resolved = resolveAccount({
      cfg: {
        channels: {
          feishu: {
            defaultAccount: "ops",
            appId: "base-app-id",
            appSecret: "base-app-secret", // pragma: allowlist secret
          },
        },
      },
      executeParams: { accountId: "OPS" },
    });

    expect(resolved.accountId).toBe("ops");
    expect(resolved.configured).toBe(true);
  });

  it.each([
    { name: "malformed", accountId: "!!!", error: "Invalid Feishu account ID" },
    { name: "unknown", accountId: "missing", error: "Unknown Feishu account" },
    { name: "disabled", accountId: "disabled", error: "is disabled" },
  ])("rejects an explicit $name account", (testCase) => {
    expect(() =>
      resolveAccount({
        executeParams: { accountId: testCase.accountId },
      }),
    ).toThrow(testCase.error);
  });
});
