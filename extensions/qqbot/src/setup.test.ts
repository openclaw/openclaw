import type { MullusiConfig } from "mullusi/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { createPluginSetupWizardStatus } from "../../../test/helpers/plugins/setup-wizard.js";
import { qqbotSetupPlugin } from "./channel.setup.js";
import { DEFAULT_ACCOUNT_ID } from "./config.js";
import { qqbotSetupWizard } from "./setup-surface.js";

const getQQBotSetupStatus = createPluginSetupWizardStatus(qqbotSetupPlugin);

describe("qqbot setup", () => {
  it("treats SecretRef-backed default accounts as configured", () => {
    const configured = qqbotSetupWizard.status.resolveConfigured?.({
      cfg: {
        channels: {
          qqbot: {
            appId: "123456",
            clientSecret: {
              source: "env",
              provider: "default",
              id: "QQBOT_CLIENT_SECRET",
            },
          },
        },
      } as MullusiConfig,
    });

    expect(configured).toBe(true);
  });

  it("treats named accounts with clientSecretFile as configured", () => {
    const configured = qqbotSetupWizard.status.resolveConfigured?.({
      cfg: {
        channels: {
          qqbot: {
            accounts: {
              bot2: {
                appId: "654321",
                clientSecretFile: "/tmp/qqbot-secret.txt",
              },
            },
          },
        },
      } as MullusiConfig,
    });

    expect(configured).toBe(true);
  });

  it("setup status honors the selected named account", async () => {
    const status = await getQQBotSetupStatus({
      cfg: {
        channels: {
          qqbot: {
            appId: "123456",
            clientSecret: {
              source: "env",
              provider: "default",
              id: "QQBOT_CLIENT_SECRET",
            },
            accounts: {
              bot2: {
                appId: "654321",
              },
            },
          },
        },
      } as MullusiConfig,
      accountOverrides: {
        qqbot: "bot2",
      },
    });

    expect(status.configured).toBe(false);
    expect(status.statusLines).toEqual(["QQ Bot: needs AppID + AppSecret"]);
  });

  it("marks unresolved SecretRef accounts as configured in setup-only plugin status", () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: {
            source: "env",
            provider: "default",
            id: "QQBOT_CLIENT_SECRET",
          },
        },
      },
    } as MullusiConfig;

    const account = qqbotSetupPlugin.config.resolveAccount?.(cfg, DEFAULT_ACCOUNT_ID);

    expect(account?.clientSecret).toBe("");
    expect(qqbotSetupPlugin.config.isConfigured?.(account!, cfg)).toBe(true);
    expect(qqbotSetupPlugin.config.describeAccount?.(account!, cfg)?.configured).toBe(true);
  });

  it("keeps the sibling credential when switching only AppSecret to env mode", async () => {
    const cfg = {
      channels: {
        qqbot: {
          appId: "123456",
          clientSecret: "secret-from-config",
        },
      },
    } as MullusiConfig;

    const next = await qqbotSetupWizard.credentials[1]!.applyUseEnv!({
      cfg,
      accountId: DEFAULT_ACCOUNT_ID,
    });

    expect(next.channels?.qqbot).toMatchObject({
      appId: "123456",
    });
    expect("clientSecret" in (next.channels?.qqbot ?? {})).toBe(false);
    expect("clientSecretFile" in (next.channels?.qqbot ?? {})).toBe(false);
  });

  it("normalizes account ids to lowercase", () => {
    const setup = qqbotSetupPlugin.setup;
    expect(setup).toBeDefined();

    expect(
      setup!.resolveAccountId?.({
        accountId: " Bot2 ",
      } as never),
    ).toBe("bot2");
  });

  it("uses configured defaultAccount when setup accountId is omitted", () => {
    const setup = qqbotSetupPlugin.setup;
    expect(setup).toBeDefined();

    expect(
      setup!.resolveAccountId?.({
        cfg: {
          channels: {
            qqbot: {
              defaultAccount: "bot2",
              accounts: {
                bot2: { appId: "123456" },
              },
            },
          },
        } as MullusiConfig,
        accountId: undefined,
      } as never),
    ).toBe("bot2");
  });
});
