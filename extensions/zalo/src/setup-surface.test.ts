import { describe, expect, it, vi } from "vitest";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  type WizardPrompter,
} from "../../../test/helpers/plugins/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { zaloPlugin } from "./channel.js";
import { zaloDmPolicy } from "./setup-core.js";
import { zaloSetupWizard } from "./setup-surface.js";

const zaloConfigure = createPluginSetupWizardConfigure(zaloPlugin);

describe("zalo setup wizard", () => {
  it("configures a polling token flow", async () => {
    const prompter = createTestWizardPrompter({
      select: vi.fn(async () => "plaintext") as WizardPrompter["select"],
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter Zalo bot token") {
          return "12345689:abc-xyz";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Use webhook mode for Zalo?") {
          return false;
        }
        return false;
      }),
    });

    const result = await runSetupWizardConfigure({
      configure: zaloConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalo?.enabled).toBe(true);
    expect(result.cfg.channels?.zalo?.botToken).toBe("12345689:abc-xyz");
    expect(result.cfg.channels?.zalo?.webhookUrl).toBeUndefined();
  });

  it("reads the named-account DM policy instead of the channel root", () => {
    expect(
      zaloDmPolicy.getCurrent(
        {
          channels: {
            zalo: {
              dmPolicy: "disabled",
              accounts: {
                work: {
                  botToken: "12345689:abc-xyz",
                  dmPolicy: "allowlist",
                },
              },
            },
          },
        } as OpenClawConfig,
        "work",
      ),
    ).toBe("allowlist");
  });

  it("reports account-scoped config keys for named accounts", () => {
    expect(zaloDmPolicy.resolveConfigKeys?.({} as OpenClawConfig, "work")).toEqual({
      policyKey: "channels.zalo.accounts.work.dmPolicy",
      allowFromKey: "channels.zalo.accounts.work.allowFrom",
    });
  });

  it("uses configured defaultAccount for omitted DM policy account context", () => {
    const cfg = {
      channels: {
        zalo: {
          defaultAccount: "work",
          dmPolicy: "disabled",
          allowFrom: ["123456789"],
          accounts: {
            work: {
              botToken: "12345689:abc-xyz",
              dmPolicy: "allowlist",
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(zaloDmPolicy.getCurrent(cfg)).toBe("allowlist");
    expect(zaloDmPolicy.resolveConfigKeys?.(cfg)).toEqual({
      policyKey: "channels.zalo.accounts.work.dmPolicy",
      allowFromKey: "channels.zalo.accounts.work.allowFrom",
    });

    const next = zaloDmPolicy.setPolicy(cfg, "open");
    expect(next.channels?.zalo?.dmPolicy).toBe("disabled");
    expect(next.channels?.zalo?.accounts?.work?.dmPolicy).toBe("open");
  });

  it('writes open policy state to the named account and preserves inherited allowFrom with "*"', () => {
    const next = zaloDmPolicy.setPolicy(
      {
        channels: {
          zalo: {
            allowFrom: ["123456789"],
            accounts: {
              work: {
                botToken: "12345689:abc-xyz",
              },
            },
          },
        },
      } as OpenClawConfig,
      "open",
      "work",
    );

    expect(next.channels?.zalo?.dmPolicy).toBeUndefined();
    expect(next.channels?.zalo?.accounts?.work?.dmPolicy).toBe("open");
    expect(next.channels?.zalo?.accounts?.work?.allowFrom).toEqual(["123456789", "*"]);
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await zaloSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          zalo: {
            defaultAccount: "work",
            botToken: "root-token",
            accounts: {
              alerts: {
                botToken: "alerts-token",
              },
              work: {
                botToken: "",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(false);
  });
});
