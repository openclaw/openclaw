import type { OpenClawConfig, RuntimeEnv, WizardPrompter } from "openclaw/plugin-sdk/zalo";
import { describe, expect, it, vi } from "vitest";
import { buildChannelOnboardingAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import { zaloPlugin } from "./channel.js";

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => "plaintext") as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "") as WizardPrompter["text"],
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  };
}

const zaloConfigureAdapter = buildChannelOnboardingAdapterFromSetupWizard({
  plugin: zaloPlugin,
  wizard: zaloPlugin.setupWizard!,
});

describe("zalo setup wizard", () => {
  it("configures a polling token flow", async () => {
    const prompter = createPrompter({
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

    const runtime: RuntimeEnv = createRuntimeEnv();

    const result = await zaloConfigureAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime,
      prompter,
      options: { secretInputMode: "plaintext" },
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalo?.enabled).toBe(true);
    expect(result.cfg.channels?.zalo?.botToken).toBe("12345689:abc-xyz");
    expect(result.cfg.channels?.zalo?.webhookUrl).toBeUndefined();
  });
});
