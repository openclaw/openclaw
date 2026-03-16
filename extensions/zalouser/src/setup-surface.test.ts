import type { OpenClawConfig, WizardPrompter } from "openclaw/plugin-sdk/zalouser";
import { describe, expect, it, vi } from "vitest";
import { buildChannelOnboardingAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";

vi.mock("./zalo-js.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./zalo-js.js")>();
  return {
    ...actual,
    checkZaloAuthenticated: vi.fn(async () => false),
    logoutZaloProfile: vi.fn(async () => {}),
    startZaloQrLogin: vi.fn(async () => ({
      message: "qr pending",
      qrDataUrl: undefined,
    })),
    waitForZaloQrLogin: vi.fn(async () => ({
      connected: false,
      message: "login pending",
    })),
    resolveZaloAllowFromEntries: vi.fn(async ({ entries }: { entries: string[] }) =>
      entries.map((entry) => ({ input: entry, resolved: true, id: entry, note: undefined })),
    ),
    resolveZaloGroupsByEntries: vi.fn(async ({ entries }: { entries: string[] }) =>
      entries.map((entry) => ({ input: entry, resolved: true, id: entry, note: undefined })),
    ),
  };
});

import { zalouserPlugin } from "./channel.js";

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

const zalouserConfigureAdapter = buildChannelOnboardingAdapterFromSetupWizard({
  plugin: zalouserPlugin,
  wizard: zalouserPlugin.setupWizard!,
});

describe("zalouser setup wizard", () => {
  it("enables the account without forcing QR login", async () => {
    const runtime = createRuntimeEnv();
    const prompter = createPrompter({
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return false;
        }
        return false;
      }),
    });

    const result = await zalouserConfigureAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime,
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalouser?.enabled).toBe(true);
  });
});
