import type { OpenClawConfig } from "openclaw/plugin-sdk/zalouser";
import { describe, expect, it, vi } from "vitest";
import { buildChannelSetupWizardAdapterFromSetupWizard } from "../../../src/channels/plugins/setup-wizard.js";
import { createRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import { createTestWizardPrompter } from "../../../test/helpers/extensions/setup-wizard.js";

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
    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
  });

  it("prompts DM policy before group access in quickstart", async () => {
    const runtime = createRuntimeEnv();
    const seen: string[] = [];
    const prompter = createTestWizardPrompter({
      confirm: vi.fn(async ({ message }: { message: string }) => {
        seen.push(message);
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return false;
        }
        return false;
      }),
      select: vi.fn(
        async ({ message, options }: { message: string; options: Array<{ value: string }> }) => {
          const first = options[0];
          if (!first) {
            throw new Error("no options");
          }
          seen.push(message);
          if (message === "Zalo Personal DM policy") {
            return "pairing";
          }
          return first.value;
        },
      ) as ReturnType<typeof createTestWizardPrompter>["select"],
    });

    const result = await zalouserConfigureAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime,
      prompter,
      options: { quickstartDefaults: true },
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
    expect(result.cfg.channels?.zalouser?.dmPolicy).toBe("pairing");
    expect(seen.indexOf("Zalo Personal DM policy")).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("Configure Zalo groups access?")).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf("Zalo Personal DM policy")).toBeLessThan(
      seen.indexOf("Configure Zalo groups access?"),
    );
  });

  it("allows an empty quickstart DM allowlist with a warning", async () => {
    const runtime = createRuntimeEnv();
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = createTestWizardPrompter({
      note,
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return false;
        }
        return false;
      }),
      select: vi.fn(
        async ({ message, options }: { message: string; options: Array<{ value: string }> }) => {
          const first = options[0];
          if (!first) {
            throw new Error("no options");
          }
          if (message === "Zalo Personal DM policy") {
            return "allowlist";
          }
          return first.value;
        },
      ) as ReturnType<typeof createTestWizardPrompter>["select"],
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Zalouser allowFrom (name or user id)") {
          return "";
        }
        return "";
      }) as ReturnType<typeof createTestWizardPrompter>["text"],
    });

    const result = await zalouserConfigureAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime,
      prompter,
      options: { quickstartDefaults: true },
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
    expect(result.cfg.channels?.zalouser?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.zalouser?.allowFrom).toEqual([]);
    expect(
      note.mock.calls.some(([message]) =>
        String(message).includes("No DM allowlist entries added yet."),
      ),
    ).toBe(true);
  });

  it("allows an empty group allowlist with a warning", async () => {
    const runtime = createRuntimeEnv();
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = createTestWizardPrompter({
      note,
      confirm: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return true;
        }
        return false;
      }),
      select: vi.fn(
        async ({ message, options }: { message: string; options: Array<{ value: string }> }) => {
          const first = options[0];
          if (!first) {
            throw new Error("no options");
          }
          if (message === "Zalo groups access") {
            return "allowlist";
          }
          return first.value;
        },
      ) as ReturnType<typeof createTestWizardPrompter>["select"],
      text: vi.fn(async ({ message }: { message: string }) => {
        if (message === "Zalo groups allowlist (comma-separated)") {
          return "";
        }
        return "";
      }) as ReturnType<typeof createTestWizardPrompter>["text"],
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

    expect(result.cfg.channels?.zalouser?.groupPolicy).toBe("allowlist");
    expect(result.cfg.channels?.zalouser?.groups).toEqual({});
    expect(
      note.mock.calls.some(([message]) =>
        String(message).includes("No group allowlist entries added yet."),
      ),
    ).toBe(true);
  });

  it("preserves non-quickstart forceAllowFrom behavior", async () => {
    const runtime = createRuntimeEnv();
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const seen: string[] = [];
    const prompter = createTestWizardPrompter({
      note,
      confirm: vi.fn(async ({ message }: { message: string }) => {
        seen.push(message);
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return false;
        }
        return false;
      }),
      text: vi.fn(async ({ message }: { message: string }) => {
        seen.push(message);
        if (message === "Zalouser allowFrom (name or user id)") {
          return "";
        }
        return "";
      }) as ReturnType<typeof createTestWizardPrompter>["text"],
    });

    const result = await zalouserConfigureAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime,
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: true,
    });

    expect(result.cfg.channels?.zalouser?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.zalouser?.allowFrom).toEqual([]);
    expect(seen).not.toContain("Zalo Personal DM policy");
    expect(seen).toContain("Zalouser allowFrom (name or user id)");
    expect(
      note.mock.calls.some(([message]) =>
        String(message).includes("No DM allowlist entries added yet."),
      ),
    ).toBe(true);
  });

  it("allowlists the plugin when a plugin allowlist already exists", async () => {
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
      cfg: {
        plugins: {
          allow: ["telegram"],
        },
      } as OpenClawConfig,
      runtime,
      prompter,
      options: {},
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual(["telegram", "zalouser"]);
  });
});
