import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { describe, expect, it } from "vitest";
import { qqbotSetupPlugin } from "./channel.setup.js";
import { DEFAULT_ACCOUNT_ID } from "./config.js";
import { qqbotSetupWizard } from "./setup-surface.js";

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
      } as OpenClawConfig,
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
      } as OpenClawConfig,
    });

    expect(configured).toBe(true);
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
    } as OpenClawConfig;

    const account = qqbotSetupPlugin.config.resolveAccount?.(cfg, DEFAULT_ACCOUNT_ID);

    expect(account?.clientSecret).toBe("");
    expect(qqbotSetupPlugin.config.isConfigured?.(account!, cfg)).toBe(true);
    expect(qqbotSetupPlugin.config.describeAccount?.(account!, cfg)?.configured).toBe(true);
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
});
