import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_ACCOUNT_ID } from "../../../src/routing/session-key.js";
import type { RuntimeEnv } from "../../../src/runtime.js";
import {
  createPluginSetupWizardConfigure,
  createQueuedWizardPrompter,
  runSetupWizardConfigure,
} from "../../../test/helpers/extensions/setup-wizard.js";
import { whatsappPlugin } from "./channel.js";

const loginWebMock = vi.hoisted(() => vi.fn(async () => {}));
const pathExistsMock = vi.hoisted(() => vi.fn(async () => false));
const listWhatsAppAccountIdsMock = vi.hoisted(() => vi.fn(() => [] as string[]));
const resolveDefaultWhatsAppAccountIdMock = vi.hoisted(() => vi.fn(() => DEFAULT_ACCOUNT_ID));
const resolveWhatsAppAuthDirMock = vi.hoisted(() =>
  vi.fn(() => ({
    authDir: "/tmp/openclaw-whatsapp-test",
  })),
);

vi.mock("./login.js", () => ({
  loginWeb: loginWebMock,
}));

vi.mock("../../../src/utils.js", async () => {
  const actual =
    await vi.importActual<typeof import("../../../src/utils.js")>("../../../src/utils.js");
  return {
    ...actual,
    pathExists: pathExistsMock,
  };
});

vi.mock("./accounts.js", () => ({
  listWhatsAppAccountIds: listWhatsAppAccountIdsMock,
  resolveDefaultWhatsAppAccountId: resolveDefaultWhatsAppAccountIdMock,
  resolveWhatsAppAuthDir: resolveWhatsAppAuthDirMock,
}));

function createRuntime(): RuntimeEnv {
  return {
    error: vi.fn(),
  } as unknown as RuntimeEnv;
}

const whatsappConfigure = createPluginSetupWizardConfigure(whatsappPlugin);

async function runConfigureWithHarness(params: {
  harness: ReturnType<typeof createQueuedWizardPrompter>;
  cfg?: Parameters<typeof whatsappConfigure>[0]["cfg"];
  runtime?: RuntimeEnv;
  options?: Parameters<typeof whatsappConfigure>[0]["options"];
  accountOverrides?: Parameters<typeof whatsappConfigure>[0]["accountOverrides"];
  shouldPromptAccountIds?: boolean;
  forceAllowFrom?: boolean;
}) {
  return await runSetupWizardConfigure({
    configure: whatsappConfigure,
    cfg: params.cfg ?? {},
    runtime: params.runtime ?? createRuntime(),
    prompter: params.harness.prompter,
    options: params.options ?? {},
    accountOverrides: params.accountOverrides ?? {},
    shouldPromptAccountIds: params.shouldPromptAccountIds ?? false,
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

async function runSeparatePhoneFlow(params: { selectValues: string[]; textValues?: string[] }) {
  pathExistsMock.mockResolvedValue(true);
  const harness = createSeparatePhoneHarness({
    selectValues: params.selectValues,
    textValues: params.textValues,
  });
  const result = await runConfigureWithHarness({
    harness,
  });
  return { harness, result };
}

describe("whatsapp setup wizard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pathExistsMock.mockResolvedValue(false);
    listWhatsAppAccountIdsMock.mockReturnValue([]);
    resolveDefaultWhatsAppAccountIdMock.mockReturnValue(DEFAULT_ACCOUNT_ID);
    resolveWhatsAppAuthDirMock.mockReturnValue({ authDir: "/tmp/openclaw-whatsapp-test" });
  });

  it("applies owner allowlist when forceAllowFrom is enabled", async () => {
    const harness = createQueuedWizardPrompter({
      confirmValues: [false],
      textValues: ["+1 (555) 555-0123"],
    });

    const result = await runConfigureWithHarness({
      harness,
      forceAllowFrom: true,
    });

    expect(result.accountId).toBe(DEFAULT_ACCOUNT_ID);
    expect(loginWebMock).not.toHaveBeenCalled();
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
    pathExistsMock.mockResolvedValue(true);
    const harness = createQueuedWizardPrompter({
      confirmValues: [false],
      selectValues: ["personal"],
      textValues: ["+1 (555) 111-2222"],
    });

    const result = await runConfigureWithHarness({
      harness,
    });

    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(true);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("allowlist");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toEqual(["+15551112222"]);
  });

  it("forces wildcard allowFrom for open policy without allowFrom follow-up prompts", async () => {
    pathExistsMock.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const result = await runConfigureWithHarness({
      harness,
      cfg: {
        channels: {
          whatsapp: {
            allowFrom: ["+15555550123"],
          },
        },
      },
    });

    expect(result.cfg.channels?.whatsapp?.selfChatMode).toBe(false);
    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBe("open");
    expect(result.cfg.channels?.whatsapp?.allowFrom).toEqual(["*", "+15555550123"]);
    expect(harness.select).toHaveBeenCalledTimes(2);
    expect(harness.text).not.toHaveBeenCalled();
  });

  it("runs WhatsApp login when not linked and user confirms linking", async () => {
    pathExistsMock.mockResolvedValue(false);
    const harness = createQueuedWizardPrompter({
      confirmValues: [true],
      selectValues: ["separate", "disabled"],
    });
    const runtime = createRuntime();

    await runConfigureWithHarness({
      harness,
      runtime,
    });

    expect(loginWebMock).toHaveBeenCalledWith(false, undefined, runtime, DEFAULT_ACCOUNT_ID);
  });

  it("skips relink note when already linked and relink is declined", async () => {
    pathExistsMock.mockResolvedValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "disabled"],
    });

    await runConfigureWithHarness({
      harness,
    });

    expect(loginWebMock).not.toHaveBeenCalled();
    expect(harness.note).not.toHaveBeenCalledWith(
      expect.stringContaining("openclaw channels login"),
      "WhatsApp",
    );
  });

  it("shows follow-up login command note when not linked and linking is skipped", async () => {
    pathExistsMock.mockResolvedValue(false);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "disabled"],
    });

    await runConfigureWithHarness({
      harness,
    });

    expect(harness.note).toHaveBeenCalledWith(
      expect.stringContaining("openclaw channels login"),
      "WhatsApp",
    );
  });
});
