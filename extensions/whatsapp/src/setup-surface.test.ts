import {
  createPluginSetupWizardStatus,
  createQueuedWizardPrompter,
  runSetupWizardFinalize,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  DEFAULT_ACCOUNT_ID,
  moveSingleAccountChannelSectionToDefaultAccount,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { whatsappSetupPlugin } from "./channel.setup.js";
import { whatsappSetupWizard } from "./setup-surface.js";
import {
  createWhatsAppAllowlistModeInput,
  expectWhatsAppDefaultAccountAccessNote,
  expectWhatsAppAllowlistModeSetup,
  expectWhatsAppSeparatePhoneDisabledSetup,
  createWhatsAppLinkingHarness,
  createWhatsAppOwnerAllowlistHarness,
  createWhatsAppPersonalPhoneHarness,
  createWhatsAppRootAllowFromConfig,
  createWhatsAppWorkAccountConfig,
  expectNoWhatsAppLoginFollowup,
  expectWhatsAppLoginFollowup,
  expectWhatsAppOpenPolicySetup,
  expectWhatsAppOwnerAllowlistSetup,
  expectWhatsAppPersonalPhoneSetup,
  expectWhatsAppWorkAccountAccessNote,
  expectWhatsAppWorkAccountOpenAccess,
} from "./setup-test-helpers.js";

const hoisted = vi.hoisted(() => ({
  hasWebCredsSync: vi.fn(() => false),
  loginModuleState: { loaded: false },
  loginWeb: vi.fn(async () => {}),
  readWebAuthState: vi.fn<(authDir: string) => Promise<"linked" | "not-linked" | "unstable">>(
    async () => "not-linked",
  ),
  resolveWhatsAppAuthDir: vi.fn<
    (params: { cfg: OpenClawConfig; accountId: string }) => { authDir: string }
  >(() => ({
    authDir: "/tmp/openclaw-whatsapp-test",
  })),
}));

vi.mock("./login.js", () => {
  hoisted.loginModuleState.loaded = true;
  return { loginWeb: hoisted.loginWeb };
});

vi.mock("./creds-files.js", async () => {
  const actual = await vi.importActual<typeof import("./creds-files.js")>("./creds-files.js");
  return {
    ...actual,
    hasWebCredsSync: hoisted.hasWebCredsSync,
  };
});

vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return { ...actual, resolveWhatsAppAuthDir: hoisted.resolveWhatsAppAuthDir };
});

vi.mock("./auth-store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
  return { ...actual, readWebAuthState: hoisted.readWebAuthState };
});

const whatsappGetStatus = createPluginSetupWizardStatus({
  id: "whatsapp",
  meta: { label: "WhatsApp" },
  setupWizard: whatsappSetupWizard,
} as never);

async function runFinalizeWithHarness(params: {
  harness: ReturnType<typeof createQueuedWizardPrompter>;
  cfg?: Parameters<NonNullable<typeof whatsappSetupWizard.finalize>>[0]["cfg"];
  runtime?: RuntimeEnv;
  forceAllowFrom?: boolean;
  accountId?: string;
  options?: Parameters<NonNullable<typeof whatsappSetupWizard.finalize>>[0]["options"];
}) {
  const result = await runSetupWizardFinalize({
    finalize: whatsappSetupWizard.finalize,
    cfg: params.cfg ?? {},
    accountId: params.accountId ?? DEFAULT_ACCOUNT_ID,
    runtime: params.runtime ?? createRuntimeSpies(),
    prompter: params.harness.prompter,
    options: params.options,
    forceAllowFrom: params.forceAllowFrom ?? false,
  });
  if (!result || typeof result !== "object" || !("cfg" in result) || !result.cfg) {
    throw new Error("Expected WhatsApp finalize result with cfg");
  }
  return result as { cfg: OpenClawConfig };
}

function createSeparatePhoneHarness(selectValues: string[]) {
  return createQueuedWizardPrompter({ confirmValues: [false], selectValues });
}

function whatsappConfig(
  whatsapp: NonNullable<NonNullable<OpenClawConfig["channels"]>["whatsapp"]>,
): OpenClawConfig {
  return { channels: { whatsapp } };
}

function workConfig(
  extra: { defaultAccount?: string; accounts?: Record<string, { authDir: string }> } = {},
) {
  return { channels: { whatsapp: { accounts: { work: { authDir: "/tmp/work" } }, ...extra } } };
}

describe("whatsapp setup wizard", () => {
  beforeEach(() => {
    hoisted.hasWebCredsSync.mockReset().mockReturnValue(false);
    hoisted.loginWeb.mockReset().mockImplementation(async (...args: unknown[]) => {
      const loginOptions = args[4] as
        | { beforeCredentialPersistence?: () => Promise<void> }
        | undefined;
      await loginOptions?.beforeCredentialPersistence?.();
    });
    hoisted.readWebAuthState.mockReset().mockResolvedValue("not-linked");
    hoisted.resolveWhatsAppAuthDir
      .mockReset()
      .mockReturnValue({ authDir: "/tmp/openclaw-whatsapp-test" });
  });

  it("applies owner allowlist when forceAllowFrom is enabled", async () => {
    const harness = createWhatsAppOwnerAllowlistHarness(createQueuedWizardPrompter);

    const result = await runFinalizeWithHarness({ harness, forceAllowFrom: true });

    expect(hoisted.loginWeb).not.toHaveBeenCalled();
    expectWhatsAppOwnerAllowlistSetup(result.cfg, harness);
    const prompt = harness.text.mock.calls.at(0)?.[0] as
      | { validate?: (value: string) => string | undefined }
      | undefined;
    if (!prompt?.validate) {
      throw new Error("expected owner number validator");
    }
    expect(prompt.validate("abc")).toBe("Invalid number: abc");
    expect(prompt.validate("whatsapp:")).toBe("Invalid number: whatsapp:");
    expect(prompt.validate("+1 (555) 555-0123")).toBeUndefined();
  });

  it.each(["work", ""])("writes scoped DM policy for selected account %j", async (accountId) => {
    const harness = createSeparatePhoneHarness(["separate", "open"]);
    const named = await runFinalizeWithHarness({
      harness,
      accountId,
      cfg: createWhatsAppWorkAccountConfig(accountId ? {} : { defaultAccount: "work" }),
    });

    expectWhatsAppWorkAccountOpenAccess(named.cfg);
    expectWhatsAppWorkAccountAccessNote(harness);
  });

  it.each([
    ["not-linked", "not linked"],
    ["unstable", "auth stabilizing"],
  ] as const)("labels the selected account when %s", async (state, label) => {
    hoisted.readWebAuthState.mockResolvedValue(state);
    if (state === "unstable") {
      hoisted.resolveWhatsAppAuthDir.mockReturnValue({ authDir: "/tmp/work" });
    }
    const status = await whatsappGetStatus({
      cfg: workConfig(),
      accountOverrides: { whatsapp: "work" },
    });

    expect(status).toMatchObject({ configured: false, statusLines: [`WhatsApp (work): ${label}`] });
  });

  it("uses configured defaultAccount for omitted-account setup status", async () => {
    hoisted.resolveWhatsAppAuthDir.mockImplementation(({ accountId }: { accountId: string }) => ({
      authDir: accountId === "work" ? "/tmp/work" : "/tmp/default",
    }));
    hoisted.readWebAuthState.mockImplementation(async (authDir: string) =>
      authDir === "/tmp/work" ? "linked" : "not-linked",
    );

    const status = await whatsappGetStatus({
      cfg: workConfig({
        defaultAccount: "work",
        accounts: {
          default: { authDir: "/tmp/default" },
          work: { authDir: "/tmp/work" },
        },
      }),
      accountOverrides: {},
    });

    expect(status).toMatchObject({ configured: true, statusLines: ["WhatsApp (work): linked"] });
    expect(hoisted.readWebAuthState).toHaveBeenCalledWith("/tmp/default");
    expect(hoisted.readWebAuthState).toHaveBeenCalledWith("/tmp/work");
  });

  it("enables allowlist self-chat mode for personal-phone setup", async () => {
    const harness = createWhatsAppPersonalPhoneHarness(createQueuedWizardPrompter);

    const result = await runFinalizeWithHarness({ harness });

    expectWhatsAppPersonalPhoneSetup(result.cfg);
  });

  it("forces wildcard allowFrom for open policy without allowFrom follow-up prompts", async () => {
    const harness = createSeparatePhoneHarness(["separate", "open"]);

    const result = await runFinalizeWithHarness({
      harness,
      cfg: createWhatsAppRootAllowFromConfig() as OpenClawConfig,
    });

    expectWhatsAppOpenPolicySetup(result.cfg, harness);
  });

  it("runs WhatsApp login when not linked and user confirms linking", async () => {
    const harness = createWhatsAppLinkingHarness(createQueuedWizardPrompter);
    const runtime = createRuntimeSpies();
    expect(hoisted.loginModuleState.loaded).toBe(false);
    const beforePersistentEffect = vi.fn(async () => {
      expect(hoisted.loginModuleState.loaded).toBe(true);
    });

    await runFinalizeWithHarness({
      harness,
      runtime,
      options: { beforePersistentEffect },
    });

    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(hoisted.loginWeb).toHaveBeenCalledWith(false, undefined, runtime, DEFAULT_ACCOUNT_ID, {
      beforeCredentialPersistence: expect.any(Function),
    });
  });

  it("propagates the persistent-effect guard before WhatsApp login persists state", async () => {
    const harness = createWhatsAppLinkingHarness(createQueuedWizardPrompter);
    const runtime = createRuntimeSpies();
    const guardError = new Error("verified inference changed");
    const beforePersistentEffect = vi.fn(async () => {
      throw guardError;
    });

    await expect(
      runFinalizeWithHarness({
        harness,
        runtime,
        options: { beforePersistentEffect },
      }),
    ).rejects.toBe(guardError);

    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(hoisted.loginWeb).toHaveBeenCalledTimes(1);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it("rejects delayed credential persistence when the inference route changes during login", async () => {
    const harness = createWhatsAppLinkingHarness(createQueuedWizardPrompter);
    const runtime = createRuntimeSpies();
    const guardError = new Error("verified inference route changed");
    let routeOwner = "original";
    const beforePersistentEffect = vi.fn(async () => {
      if (routeOwner !== "original") {
        throw guardError;
      }
    });
    hoisted.loginWeb.mockImplementationOnce(async (...args: unknown[]) => {
      const loginOptions = args[4] as
        | { beforeCredentialPersistence?: () => Promise<void> }
        | undefined;
      routeOwner = "replacement";
      await loginOptions?.beforeCredentialPersistence?.();
    });

    await expect(
      runFinalizeWithHarness({
        harness,
        runtime,
        options: { beforePersistentEffect },
      }),
    ).rejects.toBe(guardError);

    expect(beforePersistentEffect).toHaveBeenCalledTimes(1);
    expect(hoisted.loginWeb).toHaveBeenCalledTimes(1);
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it.each([true, false])("shows login followup only when unlinked (linked: %s)", async (linked) => {
    hoisted.hasWebCredsSync.mockReturnValue(linked);
    const harness = createSeparatePhoneHarness(["separate", "disabled"]);

    await runFinalizeWithHarness({ harness });

    expect(hoisted.loginWeb).not.toHaveBeenCalled();
    if (linked) {
      expectNoWhatsAppLoginFollowup(harness);
    } else {
      expectWhatsAppLoginFollowup(harness);
    }
  });
  it("skips interactive linking when the client defers device linking", async () => {
    hoisted.hasWebCredsSync.mockReturnValue(true);
    const harness = createQueuedWizardPrompter({
      confirmValues: [false],
      selectValues: ["separate", "disabled"],
    });

    const result = await runFinalizeWithHarness({
      harness,
      options: { deferDeviceLinkToClient: true },
    });

    expect(hoisted.loginWeb).not.toHaveBeenCalled();
    expect(harness.confirm).not.toHaveBeenCalled();
    expectWhatsAppSeparatePhoneDisabledSetup(result.cfg, harness);
  });

  it("normalizes allowFrom entries when list mode is selected", async () => {
    hoisted.hasWebCredsSync.mockReturnValue(true);
    const harness = createQueuedWizardPrompter({
      confirmValues: [false],
      ...createWhatsAppAllowlistModeInput(),
    });
    const result = await runFinalizeWithHarness({ harness });

    expectWhatsAppAllowlistModeSetup(result.cfg);
  });

  it.each([
    [["separate", "allowlist", "list"], "Invalid WhatsApp allowFrom list"],
    [["personal"], "Invalid WhatsApp owner number"],
  ] as const)("rejects undefined input for %j", async (selectValues, error) => {
    hoisted.hasWebCredsSync.mockReturnValue(selectValues[0] === "personal");
    const harness = createSeparatePhoneHarness([...selectValues]);
    harness.text.mockResolvedValueOnce(undefined as never);
    await expect(runFinalizeWithHarness({ harness })).rejects.toThrow(error);
  });

  it("surfaces mixed-case default-account group warning paths for named accounts", () => {
    const warnings = whatsappSetupPlugin.security?.collectWarnings?.({
      cfg: whatsappConfig({
        accounts: {
          Default: { groupPolicy: "open" },
          work: { authDir: "/tmp/work" },
        },
      }),
      accountId: "work",
      account: {
        accountId: "work",
        enabled: true,
        sendReadReceipts: true,
        authDir: "/tmp/work",
        isLegacyAuthDir: false,
        groupPolicy: "open",
      },
    });

    expect(warnings).toEqual([
      {
        checkId: "channels.whatsapp.groups.open",
        severity: "warn",
        title: "WhatsApp security warning",
        detail:
          'WhatsApp groups: groupPolicy="open" with no channels.whatsapp.accounts.Default.groups allowlist; any group can add + ping (mention-gated). Set channels.whatsapp.accounts.Default.groupPolicy="allowlist" + channels.whatsapp.accounts.Default.groupAllowFrom or configure channels.whatsapp.accounts.Default.groups.',
      },
    ]);
  });

  it.each(["default", "Default"])(
    "writes scoped DM policy to %s without duplicate keys",
    async (key) => {
      hoisted.hasWebCredsSync.mockReturnValue(true);
      const harness = createSeparatePhoneHarness(["separate", "open"]);
      const authDir = "/tmp/default-auth";
      const result = await runFinalizeWithHarness({
        harness,
        cfg: workConfig({
          accounts: {
            work: { authDir: "/tmp/work" },
            ...(key === "Default" ? { Default: { authDir } } : {}),
          },
        }),
      });
      const channel = result.cfg.channels?.whatsapp;
      expect(channel?.dmPolicy).toBeUndefined();
      expect(channel?.allowFrom).toBeUndefined();
      expect(channel?.accounts?.[key]).toMatchObject({ dmPolicy: "open", allowFrom: ["*"] });
      if (key === "Default") {
        expect(channel?.accounts?.Default?.authDir).toBe(authDir);
        expect(channel?.accounts?.default).toBeUndefined();
      } else {
        expectWhatsAppDefaultAccountAccessNote(harness);
      }
    },
  );

  it("keeps config distinct from indeterminate linkage", async () => {
    hoisted.readWebAuthState.mockResolvedValueOnce("unstable");
    const account = { authDir: "/tmp/work" } as never;

    expect(whatsappSetupPlugin.config.isConfigured?.(account, {} as never)).toBe(true);
    await expect(whatsappSetupPlugin.config.isLinked?.(account, {} as never)).resolves.toBe(
      "unknown",
    );
  });
  it("keeps shared root policy while writing an explicit scoped auth directory", () => {
    const cfg = whatsappConfig({
      dmPolicy: "allowlist",
      allowFrom: ["+15550001111"],
      accounts: { work: { authDir: "/synthetic/work" } },
    });
    const setup = whatsappSetupPlugin.setupContract!;
    const preserved = moveSingleAccountChannelSectionToDefaultAccount({
      cfg,
      channelKey: "whatsapp",
      setupSurface: setup,
    });
    expect(preserved).toEqual(cfg);
    const next = setup.applyAccountConfig({
      cfg: preserved,
      accountId: "default",
      input: { authDir: "/synthetic/default" },
    });
    expect(next.channels?.whatsapp?.accounts).toEqual({
      work: { authDir: "/synthetic/work" },
      default: { enabled: true, authDir: "/synthetic/default" },
    });
    expect(next.channels?.whatsapp?.allowFrom).toEqual(["+15550001111"]);
  });
});
