import { installChannelDmPolicyContractSuite } from "openclaw/plugin-sdk/channel-test-helpers";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  runSetupWizardFinalize,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { WizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import { zaloPlugin } from "./channel.js";
import { zaloDmPolicy } from "./setup-core.js";
import { zaloSetupAdapter, zaloSetupWizard } from "./setup-surface.js";
import type { ZaloConfig } from "./types.js";

const config = (zalo: ZaloConfig): OpenClawConfig => ({ channels: { zalo } });
const zaloConfigure = createPluginSetupWizardConfigure({
  id: zaloPlugin.id,
  meta: zaloPlugin.meta,
  capabilities: zaloPlugin.capabilities,
  config: zaloPlugin.config,
  setup: zaloSetupAdapter,
  setupWizard: zaloSetupWizard,
});

describe("zalo setup wizard", () => {
  it.each([
    { accountId: "default", replaceToken: false },
    { accountId: "work", replaceToken: false },
    { accountId: "default", replaceToken: true },
    { accountId: "work", replaceToken: true },
  ])(
    "switches $accountId to polling (replaceToken=$replaceToken)",
    async ({ accountId, replaceToken }) => {
      const account = {
        enabled: false,
        botToken: "old-token",
        webhookUrl: "https://example.com/zalo",
        webhookSecret: "webhook-secret",
        webhookPath: "/zalo",
        allowFrom: ["123456789"],
      };
      const sibling = { enabled: false, botToken: "sibling-token" };
      const cfg = config({
        enabled: false,
        ...(accountId === "default" ? account : {}),
        accounts: { ...(accountId === "work" ? { work: account } : {}), alerts: sibling },
      });
      const prompter = createTestWizardPrompter({
        confirm: vi.fn(async ({ message }) =>
          message === "Zalo token already configured. Keep it?" ? !replaceToken : false,
        ),
        text: vi.fn(async () => "new-token") as WizardPrompter["text"],
      });

      const result = await runSetupWizardFinalize({
        finalize: zaloSetupWizard.finalize,
        cfg,
        accountId,
        prompter,
        options: { secretInputMode: "plaintext" as const },
      });
      const channel = result?.cfg?.channels?.zalo;
      const selected = accountId === "default" ? channel : channel?.accounts?.work;
      expect(selected).toMatchObject({
        enabled: replaceToken,
        botToken: replaceToken ? "new-token" : "old-token",
        allowFrom: ["123456789"],
      });
      expect(selected).not.toHaveProperty("webhookUrl");
      expect(selected).not.toHaveProperty("webhookSecret");
      expect(selected).not.toHaveProperty("webhookPath");
      expect(channel?.enabled).toBe(replaceToken);
      expect(channel?.accounts?.alerts).toEqual(sibling);
      expect(cfg.channels?.zalo?.enabled).toBe(false);
      expect(account.webhookUrl).toBe("https://example.com/zalo");
    },
  );

  it("configures a polling token flow", async () => {
    const prompter = createTestWizardPrompter({
      select: vi.fn(async () => "plaintext") as WizardPrompter["select"],
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Enter Zalo bot token") {
          return "12345689:abc-xyz";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      configure: zaloConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalo).toMatchObject({
      enabled: true,
      botToken: "12345689:abc-xyz",
    });
    expect(result.cfg.channels?.zalo?.webhookUrl).toBeUndefined();
  });

  installChannelDmPolicyContractSuite({
    dmPolicy: zaloDmPolicy,
    cases: [
      {
        name: "Zalo named accounts",
        channel: "zalo",
        accountId: "work",
        accountConfig: { botToken: "12345689:abc-xyz" },
        inheritedAllowFrom: ["123456789"],
        defaultAccount: { rootAllowFrom: ["123456789"] },
      },
    ],
  });

  it("uses configured defaultAccount for omitted setup configured state", async () => {
    const configured = await zaloSetupWizard.status.resolveConfigured({
      cfg: config({
        defaultAccount: "work",
        botToken: "root-token",
        accounts: { alerts: { botToken: "alerts-token" }, work: { botToken: "" } },
      }),
    });

    expect(configured).toBe(false);
  });
});
