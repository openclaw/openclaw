import { describe, expect, it, vi } from "vitest";
import {
  createPluginSetupWizardAdapter,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  type WizardPrompter,
} from "../../../test/helpers/extensions/setup-wizard.js";
import type { OpenClawConfig } from "../api.js";
import { tlonPlugin } from "./channel.js";

const tlonConfigureAdapter = createPluginSetupWizardAdapter(tlonPlugin);

describe("tlon setup wizard", () => {
  it("configures ship, auth, and discovery settings", async () => {
    const prompter = createTestWizardPrompter({
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

    const result = await runSetupWizardConfigure({
      configure: tlonConfigureAdapter.configure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
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
