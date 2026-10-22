import {
  createPluginSetupWizardStatus,
  createQueuedWizardPrompter,
  runSetupWizardFinalize,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { DEFAULT_ACCOUNT_ID, type OpenClawConfig } from "openclaw/plugin-sdk/setup";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { whatsappSetupWizard } from "./setup-surface.js";
import {
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
});
