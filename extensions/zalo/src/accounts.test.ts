// Zalo tests cover accounts plugin behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  inspectZaloAccount,
  listZaloAccountIds,
  resolveDefaultZaloAccountId,
  resolveZaloAccount,
} from "./accounts.js";
import { zaloPlugin } from "./channel.js";

describe("resolveZaloAccount", () => {
  it("keeps the implicit default account when named accounts are added to top-level credentials", () => {
    const cfg = {
      channels: {
        zalo: {
          botToken: "default-token",
          accounts: {
            work: {
              enabled: false,
              botToken: "work-token",
            },
          },
        },
      },
    };

    expect(listZaloAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultZaloAccountId(cfg)).toBe("default");
    expect(resolveZaloAccount({ cfg, accountId: "default" }).enabled).toBe(true);
  });

  it("carries account-owned unavailable credential diagnostics into the resolved account", () => {
    const tokenFile = "/private/zalo-resolved-account-token";
    const resolved = resolveZaloAccount({
      cfg: {
        channels: {
          zalo: {
            botToken: "lower-priority-token",
            accounts: { work: { tokenFile } },
          },
        },
      },
      accountId: "work",
    });

    expect(resolved).toMatchObject({
      token: "",
      tokenSource: "configFile",
      tokenStatus: "configured_unavailable",
      credentialDiagnostics: [
        {
          code: "CREDENTIAL_FILE_UNAVAILABLE",
          path: "channels.zalo.accounts.work.tokenFile",
          reason: "not-found",
        },
      ],
    });
    expect(JSON.stringify(resolved.credentialDiagnostics)).not.toContain(tokenFile);
  });
});

describe("Zalo account SecretRef inspection", () => {
  afterEach(() => vi.unstubAllEnvs());

  const unresolvedRef = {
    source: "env" as const,
    provider: "default",
    id: "OPENCLAW_TEST_MISSING_ZALO_TOKEN",
  };

  it.each([
    { botToken: "bot-token", webhookUrl: undefined, configured: true, mode: "polling" },
    {
      botToken: unresolvedRef,
      webhookUrl: "https://bot.example.com/zalo",
      configured: true,
      mode: "webhook",
    },
  ])("reports $mode inspection with configured=$configured", async (entry) => {
    const cfg = {
      channels: {
        zalo: {
          accounts: {
            work: {
              botToken: entry.botToken,
              webhookUrl: entry.webhookUrl,
              dmPolicy: "open" as const,
            },
          },
        },
      },
    };
    const account = inspectZaloAccount({ cfg, accountId: "work" });
    expect(await zaloPlugin.config.isConfigured?.(account, cfg)).toBe(entry.configured);
    expect(account).toMatchObject({
      accountId: "work",
      enabled: true,
      configured: entry.configured,
      mode: entry.mode,
      dmPolicy: "open",
    });
  });

  it("keeps direct account resolution strict", () => {
    expect(() =>
      resolveZaloAccount({ cfg: { channels: { zalo: { botToken: unresolvedRef } } } }),
    ).toThrow(/unresolved SecretRef/);
  });

  it("does not fall through an unavailable configured ref to the environment", () => {
    vi.stubEnv("ZALO_BOT_TOKEN", "lower-precedence-token");
    const account = inspectZaloAccount({
      cfg: { channels: { zalo: { botToken: unresolvedRef } } },
    });
    expect(account).toMatchObject({
      token: "",
      tokenSource: "config",
      tokenStatus: "configured_unavailable",
    });
  });
});
