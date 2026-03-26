import { describe, expect, it, vi } from "vitest";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
} from "../../../test/helpers/extensions/setup-wizard.js";
import type { OpenClawConfig } from "../runtime-api.js";
import "./zalo-js.test-mocks.js";
import { zalouserPlugin } from "./channel.js";

const zalouserConfigure = createPluginSetupWizardConfigure(zalouserPlugin);

async function runSetup(params: {
  cfg?: OpenClawConfig;
  prompter: ReturnType<typeof createTestWizardPrompter>;
  options?: Record<string, unknown>;
  forceAllowFrom?: boolean;
}) {
  return await runSetupWizardConfigure({
    configure: zalouserConfigure,
    cfg: params.cfg as OpenClawConfig | undefined,
    prompter: params.prompter,
    options: params.options,
    forceAllowFrom: params.forceAllowFrom,
  });
}

describe("zalouser setup wizard", () => {
  function createQuickstartPrompter(params?: {
    note?: ReturnType<typeof createTestWizardPrompter>["note"];
    seen?: string[];
    dmPolicy?: "pairing" | "allowlist";
    groupAccess?: boolean;
    groupPolicy?: "allowlist";
    textByMessage?: Record<string, string>;
  }) {
    const select = vi.fn(
      async ({ message, options }: { message: string; options: Array<{ value: string }> }) => {
        const first = options[0];
        if (!first) {
          throw new Error("no options");
        }
        params?.seen?.push(message);
        if (message === "Zalo Personal DM policy" && params?.dmPolicy) {
          return params.dmPolicy;
        }
        if (message === "Zalo groups access" && params?.groupPolicy) {
          return params.groupPolicy;
        }
        return first.value;
      },
    ) as ReturnType<typeof createTestWizardPrompter>["select"];
    const text = vi.fn(
      async ({ message }: { message: string }) => params?.textByMessage?.[message] ?? "",
    ) as ReturnType<typeof createTestWizardPrompter>["text"];
    return createTestWizardPrompter({
      ...(params?.note ? { note: params.note } : {}),
      confirm: vi.fn(async ({ message }: { message: string }) => {
        params?.seen?.push(message);
        if (message === "Login via QR code now?") {
          return false;
        }
        if (message === "Configure Zalo groups access?") {
          return params?.groupAccess ?? false;
        }
        return false;
      }),
      select,
      text,
    });
  }

  it("enables the account without forcing QR login", async () => {
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

    const result = await runSetup({ prompter });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
  });

  it("prompts DM policy before group access in quickstart", async () => {
    const seen: string[] = [];
    const prompter = createQuickstartPrompter({ seen, dmPolicy: "pairing" });

    const result = await runSetup({
      prompter,
      options: { quickstartDefaults: true },
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
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = createQuickstartPrompter({
      note,
      dmPolicy: "allowlist",
      textByMessage: {
        "Zalouser allowFrom (name or user id)": "",
      },
    });

    const result = await runSetup({
      prompter,
      options: { quickstartDefaults: true },
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
    const note = vi.fn(async (_message: string, _title?: string) => {});
    const prompter = createQuickstartPrompter({
      note,
      groupAccess: true,
      groupPolicy: "allowlist",
      textByMessage: {
        "Zalo groups allowlist (comma-separated)": "",
      },
    });

    const result = await runSetup({ prompter });

    expect(result.cfg.channels?.zalouser?.groupPolicy).toBe("allowlist");
    expect(result.cfg.channels?.zalouser?.groups).toEqual({});
    expect(
      note.mock.calls.some(([message]) =>
        String(message).includes("No group allowlist entries added yet."),
      ),
    ).toBe(true);
  });

  it("preserves non-quickstart forceAllowFrom behavior", async () => {
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

    const result = await runSetup({ prompter, forceAllowFrom: true });

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

    const result = await runSetup({
      cfg: {
        plugins: {
          allow: ["telegram"],
        },
      } as OpenClawConfig,
      prompter,
    });

    expect(result.cfg.plugins?.entries?.zalouser?.enabled).toBe(true);
    expect(result.cfg.plugins?.allow).toEqual(["telegram", "zalouser"]);
  });
});
