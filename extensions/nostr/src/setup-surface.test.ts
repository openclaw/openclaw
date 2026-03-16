import type { OpenClawConfig } from "openclaw/plugin-sdk/nostr";
import { describe, expect, it, vi } from "vitest";
import { buildChannelOnboardingAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import { nostrPlugin } from "./channel.js";

function createPrompter(overrides: Partial<WizardPrompter>): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async ({ options }: { options: Array<{ value: string }> }) => {
      const first = options[0];
      if (!first) {
        throw new Error("no options");
      }
      return first.value;
    }) as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => "") as WizardPrompter["text"],
    confirm: vi.fn(async () => false),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
    ...overrides,
  };
}

const nostrConfigureAdapter = buildChannelOnboardingAdapterFromSetupWizard({
  plugin: nostrPlugin,
  wizard: nostrPlugin.setupWizard!,
});

describe("nostr setup wizard", () => {
  it("configures a private key and relay URLs", async () => {
    const prompter = createPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Nostr private key (nsec... or hex)") {
          return "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        }
        if (message === "Relay URLs (comma-separated, optional)") {
          return "wss://relay.damus.io, wss://relay.primal.net";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await nostrConfigureAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime: createRuntimeEnv(),
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.nostr?.enabled).toBe(true);
    expect(result.cfg.channels?.nostr?.privateKey).toBe(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    );
    expect(result.cfg.channels?.nostr?.relays).toEqual([
      "wss://relay.damus.io",
      "wss://relay.primal.net",
    ]);
  });
});
