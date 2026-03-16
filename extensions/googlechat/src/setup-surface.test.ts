import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/googlechat";
import { describe, expect, it, vi } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import { googlechatPlugin } from "./channel.js";

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

const googlechatConfigureAdapter = buildChannelSetupWizardAdapterFromSetupWizard({
  plugin: googlechatPlugin,
  wizard: googlechatPlugin.setupWizard!,
});

describe("googlechat setup wizard", () => {
  it("configures service-account auth and webhook audience", async () => {
    const prompter = createPrompter({
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
