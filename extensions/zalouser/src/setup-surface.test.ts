import type { OpenClawConfig } from "openclaw/plugin-sdk/zalouser";
import { describe, expect, it, vi } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { createRuntimeEnv } from "../../test-utils/runtime-env.js";
import { createTestWizardPrompter } from "../../test-utils/setup-wizard.js";

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

const zalouserConfigureAdapter = buildChannelSetupWizardAdapterFromSetupWizard({
  plugin: zalouserPlugin,
  wizard: zalouserPlugin.setupWizard!,
});

describe("zalouser setup wizard", () => {
  it("enables the account without forcing QR login", async () => {
    const runtime = createRuntimeEnv();
    const prompter = createTestWizardPrompter({
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
