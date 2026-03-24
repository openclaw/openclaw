import { describe, expect, it, vi } from "vitest";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  type WizardPrompter,
} from "../../../test/helpers/extensions/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { nostrPlugin } from "./channel.js";
import { TEST_HEX_PRIVATE_KEY, TEST_SETUP_RELAY_URLS } from "./test-fixtures.js";

const nostrConfigure = createPluginSetupWizardConfigure(nostrPlugin);

describe("nostr setup wizard", () => {
  it("configures a private key and relay URLs", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Nostr private key (nsec... or hex)") {
          return TEST_HEX_PRIVATE_KEY;
        }
        if (message === "Relay URLs (comma-separated, optional)") {
          return TEST_SETUP_RELAY_URLS.join(", ");
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const result = await runSetupWizardConfigure({
      configure: nostrConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.nostr?.enabled).toBe(true);
    expect(result.cfg.channels?.nostr?.privateKey).toBe(TEST_HEX_PRIVATE_KEY);
    expect(result.cfg.channels?.nostr?.relays).toEqual(TEST_SETUP_RELAY_URLS);
  });
});
