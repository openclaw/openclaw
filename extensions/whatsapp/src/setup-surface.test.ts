import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createQueuedWizardPrompter,
  runSetupWizardFinalize,
} from "../../../test/helpers/plugins/setup-wizard.js";
import { whatsappSetupWizard } from "./setup-surface.js";

const hoisted = vi.hoisted(() => ({
  loginWeb: vi.fn(async () => {}),
  pathExists: vi.fn(async () => false),
  resolveWhatsAppAuthDir: vi.fn(() => ({
    authDir: "/tmp/openclaw-whatsapp-test",
  })),
}));

vi.mock("./login.js", () => ({
  loginWeb: hoisted.loginWeb,
}));

vi.mock("openclaw/plugin-sdk/setup", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/setup")>(
    "openclaw/plugin-sdk/setup",
  );
  return {
    ...actual,
    pathExists: hoisted.pathExists,
  };
});

vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return {
    ...actual,
    resolveWhatsAppAuthDir: hoisted.resolveWhatsAppAuthDir,
  };
});

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

async function runFinalizeWithHarness(params: {
  harness: ReturnType<typeof createQueuedWizardPrompter>;
  cfg?: Parameters<NonNullable<typeof whatsappSetupWizard.finalize>>[0]["cfg"];
  runtime?: RuntimeEnv;
  forceAllowFrom?: boolean;
  accountId?: string;
}) {
  return await runSetupWizardFinalize({
    finalize: whatsappSetupWizard.finalize,
    cfg: params.cfg ?? {},
    accountId: params.accountId ?? DEFAULT_ACCOUNT_ID,
    runtime: params.runtime ?? createRuntime(),
    prompter: params.harness.prompter,
    forceAllowFrom: params.forceAllowFrom ?? false,
  });
}

function createSeparatePhoneHarness(params: { selectValues: string[]; textValues?: string[] }) {
  return createQueuedWizardPrompter({
    confirmValues: [false],
    selectValues: params.selectValues,
    textValues: params.textValues,
  });
}

function expectFinalizeResult(result: Awaited<ReturnType<typeof runFinalizeWithHarness>>): {
  cfg: OpenClawConfig;
} {
  expect(result).toBeDefined();
  if (!result || typeof result !== "object" || !("cfg" in result) || !result.cfg) {
    throw new Error("Expected WhatsApp finalize result with cfg");
  }
  return result as { cfg: OpenClawConfig };
}

async function runSeparatePhoneFlow(params: { selectValues: string[]; textValues?: string[] }) {
  hoisted.pathExists.mockResolvedValue(true);
  const harness = createSeparatePhoneHarness({
    selectValues: params.selectValues,
    textValues: params.textValues,
  });
  const result = expectFinalizeResult(
    await runFinalizeWithHarness({
      harness,
    }),
  );
  return { harness, result };
}

describe("whatsapp setup wizard", () => {
  beforeEach(() => {
    hoisted.loginWeb.mockReset();
    hoisted.pathExists.mockReset();
    hoisted.pathExists.mockResolvedValue(false);
    hoisted.resolveWhatsAppAuthDir.mockReset();
    hoisted.resolveWhatsAppAuthDir.mockReturnValue({ authDir: "/tmp/openclaw-whatsapp-test" });
  });

  it("applies owner allowlist when forceAllowFrom is enabled", async () => {
    const harness = createQueuedWizardPrompter({
      confirmValues: [false],
      textValues: ["+1 (555) 555-0123"],
    });

    const result = expectFinalizeResult(
      await runFinalizeWithHarness({
        harness,
        forceAllowFrom: true,
      }),
    );

    expect(hoisted.loginWeb).not.toHaveBeenCalled();
    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(true);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toEqual(["+15555550123"]);
    expect(harness.text).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Your personal WhatsApp number (the phone you will message from)",
      }),
    );
  });

  it("supports disabled DM policy for separate-phone setup", async () => {
    const { harness, result } = await runSeparatePhoneFlow({
      selectValues: ["separate", "disabled"],
    });

    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(false);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("disabled");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toBeUndefined();
    expect(harness.text).not.toHaveBeenCalled();
  });

  it("writes named-account DM policy and allowFrom instead of the channel root", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const named = expectFinalizeResult(
      await runFinalizeWithHarness({
        harness,
        accountId: "work",
        cfg: {
          channels: {
            whatsapp: {
              dmPolicy: "disabled",
              allowFrom: ["+15555550123"],
              accounts: {
                work: {
                  authDir: "/tmp/work",
                },
              },
            },
          },
        },
      }),
    );

    expect(named.cfg.channels?.whatsapp?.dmPolicy).toBe("disabled");
    expect(named.cfg.channels?.whatsapp?.allowFrom).toEqual(["+15555550123"]);
    expect(named.cfg.channels?.whatsapp?.accounts?.work?.dmPolicy).toBe("open");
    expect(named.cfg.channels?.whatsapp?.accounts?.work?.allowFrom).toEqual(["*", "+15555550123"]);
    expect(harness.note).toHaveBeenCalledWith(
      expect.stringContaining(
        "`channels.whatsapp.accounts.work.dmPolicy` + `channels.whatsapp.accounts.work.allowFrom`",
      ),
      "WhatsApp DM access",
    );
  });

  it("normalizes allowFrom entries when list mode is selected", async () => {
    const { result } = await runSeparatePhoneFlow({
      selectValues: ["separate", "allowlist", "list"],
      textValues: ["+1 (555) 555-0123, +15555550123, *"],
    });

    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(false);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toEqual(["+15555550123", "*"]);
  });

  it("enables allowlist self-chat mode for personal-phone setup", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createQueuedWizardPrompter({
      confirmValues: [false],
      selectValues: ["personal"],
      textValues: ["+1 (555) 111-2222"],
    });

    const result = expectFinalizeResult(
      await runFinalizeWithHarness({
        harness,
      }),
    );

    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(true);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toEqual(["+15551112222"]);
  });

  it("forces wildcard allowFrom for open policy without allowFrom follow-up prompts", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const result = expectFinalizeResult(
      await runFinalizeWithHarness({
        harness,
        cfg: {
          channels: {
            whatsapp: {
              allowFrom: ["+15555550123"],
            },
          },
        },
      }),
    );

    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(false);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("open");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toEqual(["*", "+15555550123"]);
    expect(harness.select).toHaveBeenCalledTimes(2);
    expect(harness.text).not.toHaveBeenCalled();
  });

  it("runs WhatsApp login when not linked and user confirms linking", async () => {
    hoisted.pathExists.mockResolvedValue(false);
    const harness = createQueuedWizardPrompter({
      confirmValues: [true],
      selectValues: ["separate", "disabled"],
    });
    const runtime = createRuntime();

    await runFinalizeWithHarness({
      harness,
      runtime,
    });

    expect(hoisted.loginWeb).toHaveBeenCalledWith(false, undefined, runtime, DEFAULT_ACCOUNT_ID);
  });

  it("skips relink note when already linked and relink is declined", async () => {
    hoisted.pathExists.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "disabled"],
    });

    await runFinalizeWithHarness({
      harness,
    });

    expect(hoisted.loginWeb).not.toHaveBeenCalled();
    expect(harness.note).not.toHaveBeenCalledWith(
      expect.stringContaining("openclaw channels login"),
      "WhatsApp",
    );
  });

  it("shows follow-up login command note when not linked and linking is skipped", async () => {
    hoisted.pathExists.mockResolvedValue(false);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "disabled"],
    });

    await runFinalizeWithHarness({
      harness,
    });

    expect(harness.note).toHaveBeenCalledWith(
      expect.stringContaining("openclaw channels login"),
      "WhatsApp",
    );
  });
});
