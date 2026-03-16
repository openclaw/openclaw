import type { OpenClawConfig, RuntimeEnv, WizardPrompter } from "openclaw/plugin-sdk/tlon";
import { describe, expect, it, vi } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import { tlonPlugin } from "./channel.js";

const selectFirstOption = async <T>(params: { options: Array<{ value: T }> }): Promise<T> => {
  const first = params.options[0];
  if (!first) {
    throw new Error("no options");
  }
  return first.value;
};

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: selectFirstOption as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "") as WizardPrompter["text"],
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  };
}

const tlonConfigureAdapter = buildChannelSetupWizardAdapterFromSetupWizard({
  plugin: tlonPlugin,
  wizard: tlonPlugin.setupWizard!,
});

describe("tlon setup wizard", () => {
  it("configures ship, auth, and discovery settings", async () => {
    const prompter = createPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Ship name") {
          return "sampel-palnet";
        }
        if (message === "Ship URL") {
          return "https://urbit.example.com";
        }
        if (message === "Login code") {
          return "lidlut-tabwed-pillex-ridrup";
        }
        if (message === "Group channels (comma-separated)") {
          return "chat/~host-ship/general, chat/~host-ship/support";
        }
        if (message === "DM allowlist (comma-separated ship names)") {
          return "~zod, nec";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Add group channels manually? (optional)") {
          return true;
        }
        if (message === "Restrict DMs with an allowlist?") {
          return true;
        }
        if (message === "Enable auto-discovery of group channels?") {
          return true;
        }
        return false;
      }),
    });

    const runtime: RuntimeEnv = createRuntimeEnv();

    const result = await tlonConfigureAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime,
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.tlon?.enabled).toBe(true);
    expect(result.cfg.channels?.tlon?.ship).toBe("~sampel-palnet");
    expect(result.cfg.channels?.tlon?.url).toBe("https://urbit.example.com");
    expect(result.cfg.channels?.tlon?.code).toBe("lidlut-tabwed-pillex-ridrup");
    expect(result.cfg.channels?.tlon?.groupChannels).toEqual([
      "chat/~host-ship/general",
      "chat/~host-ship/support",
    ]);
    expect(result.cfg.channels?.tlon?.dmAllowlist).toEqual(["~zod", "~nec"]);
    expect(result.cfg.channels?.tlon?.autoDiscoverChannels).toBe(true);
    expect(result.cfg.channels?.tlon?.allowPrivateNetwork).toBe(false);
  });
});
