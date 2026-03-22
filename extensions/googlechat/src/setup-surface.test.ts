import type { OpenClawConfig } from "openclaw/plugin-sdk/googlechat";
import { describe, expect, it, vi } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { createRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import {
  createTestWizardPrompter,
  type WizardPrompter,
} from "../../../test/helpers/extensions/setup-wizard.js";
import { googlechatPlugin } from "./channel.js";

const googlechatConfigureAdapter = buildChannelSetupWizardAdapterFromSetupWizard({
  plugin: googlechatPlugin,
  wizard: googlechatPlugin.setupWizard!,
});

describe("googlechat setup wizard", () => {
  it("configures service-account auth and webhook audience", async () => {
    const prompter = createTestWizardPrompter({
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Service account JSON path") {
          return "/tmp/googlechat-service-account.json";
        }
        if (message === "App URL") {
          return "https://example.com/googlechat";
        }
        throw new Error(`Unexpected prompt: ${message}`);
      }) as WizardPrompter["text"],
    });

    const runtime = createRuntimeEnv();

    const result = await googlechatConfigureAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime,
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.googlechat?.enabled).toBe(true);
    expect(result.cfg.channels?.googlechat?.serviceAccountFile).toBe(
      "/tmp/googlechat-service-account.json",
    );
    expect(result.cfg.channels?.googlechat?.audienceType).toBe("app-url");
    expect(result.cfg.channels?.googlechat?.audience).toBe("https://example.com/googlechat");
  });
});
