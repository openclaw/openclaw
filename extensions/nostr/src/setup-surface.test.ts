import { describe, expect, it, vi } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { createRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import {
  createTestWizardPrompter,
  type WizardPrompter,
} from "../../../test/helpers/extensions/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { nostrPlugin } from "./channel.js";

const nostrConfigureAdapter = buildChannelSetupWizardAdapterFromSetupWizard({
  plugin: nostrPlugin,
  wizard: nostrPlugin.setupWizard!,
});

describe("nostr setup wizard", () => {
  it("configures a private key and relay URLs", async () => {
    const prompter = createTestWizardPrompter({
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
