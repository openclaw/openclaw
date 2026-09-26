import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createQueuedWizardPrompter } from "openclaw/plugin-sdk/plugin-test-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createRuntimeSpies } from "../../test-support/runtime-spies.js";
import { WHATSAPP_AUTH_UNSTABLE_CODE } from "./auth-store.js";
import { whatsappSetupPlugin } from "./channel.setup.js";
import { checkWhatsAppHeartbeatReady } from "./heartbeat.js";
import { finalizeWhatsAppSetup } from "./setup-finalize.js";
import {
  createWhatsAppAllowlistModeInput,
  expectWhatsAppDefaultAccountAccessNote,
  createWhatsAppOwnerAllowlistHarness,
  createWhatsAppPersonalPhoneHarness,
  expectWhatsAppAllowlistModeSetup,
  expectWhatsAppSeparatePhoneDisabledSetup,
} from "./setup-test-helpers.js";

const hoisted = vi.hoisted(() => ({
  loginWeb: vi.fn(async () => {}),
  hasWebCredsSync: vi.fn(() => false),
  readWebAuthState: vi.fn(async (): Promise<"linked" | "not-linked" | "unstable"> => "not-linked"),
  readWebAuthExistsForDecision: vi.fn(
    async (): Promise<{ outcome: "stable"; exists: boolean } | { outcome: "unstable" }> => ({
      outcome: "stable",
      exists: false,
    }),
  ),
  resolveWhatsAppAuthDir: vi.fn(() => ({
    authDir: "/tmp/openclaw-whatsapp-test",
  })),
}));

vi.mock("./login.js", () => ({
  loginWeb: hoisted.loginWeb,
}));

vi.mock("./creds-files.js", async () => {
  const actual = await vi.importActual<typeof import("./creds-files.js")>("./creds-files.js");
  return {
    ...actual,
    hasWebCredsSync: hoisted.hasWebCredsSync,
  };
});

vi.mock("./accounts.js", async () => {
  const actual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
  return {
    ...actual,
    resolveWhatsAppAuthDir: hoisted.resolveWhatsAppAuthDir,
  };
});

vi.mock("./auth-store.js", async () => {
  const actual = await vi.importActual<typeof import("./auth-store.js")>("./auth-store.js");
  return {
    ...actual,
    readWebAuthState: hoisted.readWebAuthState,
    readWebAuthExistsForDecision: hoisted.readWebAuthExistsForDecision,
  };
});

describe("WhatsApp setup promotion contract", () => {
  it("exposes authDir on the setup-only plugin surface", () => {
    expect(whatsappSetupPlugin.setupContract?.singleAccountKeysToMove).toEqual(["authDir"]);
  });
});

async function runConfigureWithHarness(params: {
  harness: ReturnType<typeof createQueuedWizardPrompter>;
  cfg?: OpenClawConfig;
  runtime?: RuntimeEnv;
  forceAllowFrom?: boolean;
}) {
  const result = await finalizeWhatsAppSetup({
    cfg: params.cfg ?? ({} as OpenClawConfig),
    accountId: DEFAULT_ACCOUNT_ID,
    forceAllowFrom: params.forceAllowFrom ?? false,
    prompter: params.harness.prompter,
    runtime: params.runtime ?? createRuntimeSpies(),
  });
  return {
    accountId: DEFAULT_ACCOUNT_ID,
    cfg: result.cfg,
  };
}

function createSeparatePhoneHarness(params: { selectValues: string[]; textValues?: string[] }) {
  return createQueuedWizardPrompter({
    confirmValues: [false],
    selectValues: params.selectValues,
    textValues: params.textValues,
  });
}

async function runSeparatePhoneFlow(params: { selectValues: string[]; textValues?: string[] }) {
  hoisted.hasWebCredsSync.mockReturnValue(true);
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
    hoisted.loginWeb.mockReset();
    hoisted.hasWebCredsSync.mockReset();
    hoisted.hasWebCredsSync.mockReturnValue(false);
    hoisted.readWebAuthState.mockReset();
    hoisted.readWebAuthState.mockResolvedValue("not-linked");
    hoisted.readWebAuthExistsForDecision.mockReset();
    hoisted.readWebAuthExistsForDecision.mockResolvedValue({
      outcome: "stable",
      exists: false,
    });
    hoisted.resolveWhatsAppAuthDir.mockReset();
    hoisted.resolveWhatsAppAuthDir.mockReturnValue({ authDir: "/tmp/openclaw-whatsapp-test" });
  });

  it("rejects invalid owner numbers during prompt validation", async () => {
    const harness = createWhatsAppOwnerAllowlistHarness(createQueuedWizardPrompter);

    await runConfigureWithHarness({
      harness,
      forceAllowFrom: true,
    });

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

  it("skips interactive linking when the client defers device linking", async () => {
    hoisted.hasWebCredsSync.mockReturnValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "disabled"],
    });

    const result = await finalizeWhatsAppSetup({
      cfg: {} as OpenClawConfig,
      accountId: DEFAULT_ACCOUNT_ID,
      forceAllowFrom: false,
      prompter: harness.prompter,
      runtime: createRuntimeSpies(),
      options: { deferDeviceLinkToClient: true },
    });

    expect(hoisted.loginWeb).not.toHaveBeenCalled();
    expect(harness.confirm).not.toHaveBeenCalled();
    expectWhatsAppSeparatePhoneDisabledSetup(result.cfg, harness);
  });

  it("normalizes allowFrom entries when list mode is selected", async () => {
    const { result } = await runSeparatePhoneFlow(createWhatsAppAllowlistModeInput());

    expectWhatsAppAllowlistModeSetup(result.cfg);
  });

  it("throws a user-facing error instead of crashing when allowlist input is undefined", async () => {
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "allowlist", "list"],
    });
    harness.text.mockResolvedValueOnce(undefined as never);

    await expect(
      runConfigureWithHarness({
        harness,
      }),
    ).rejects.toThrow("Invalid WhatsApp allowFrom list");
  });

  it("throws a user-facing error instead of crashing when personal-phone input is undefined", async () => {
    hoisted.hasWebCredsSync.mockReturnValue(true);
    const harness = createWhatsAppPersonalPhoneHarness(createQueuedWizardPrompter);
    harness.text.mockResolvedValueOnce(undefined as never);

    await expect(
      runConfigureWithHarness({
        harness,
      }),
    ).rejects.toThrow("Invalid WhatsApp owner number");
  });

  it("surfaces mixed-case default-account group warning paths for named accounts", () => {
    const warnings = whatsappSetupPlugin.security?.collectWarnings?.({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              Default: {
                groupPolicy: "open",
              },
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as OpenClawConfig,
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

  it("writes default-account DM config into accounts.default for multi-account setups", async () => {
    hoisted.hasWebCredsSync.mockReturnValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const result = await runConfigureWithHarness({
      harness,
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(result.cfg.channels?.whatsapp?.dmPolicy).toBeUndefined();
    expect(result.cfg.channels?.whatsapp?.allowFrom).toBeUndefined();
    expect(result.cfg.channels?.whatsapp?.accounts?.default?.dmPolicy).toBe("open");
    expect(result.cfg.channels?.whatsapp?.accounts?.default?.allowFrom).toEqual(["*"]);
    expectWhatsAppDefaultAccountAccessNote(harness);
  });

  it("updates an existing mixed-case default-account key during setup", async () => {
    hoisted.hasWebCredsSync.mockReturnValue(true);
    const harness = createSeparatePhoneHarness({
      selectValues: ["separate", "open"],
    });

    const result = await runConfigureWithHarness({
      harness,
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              Default: {
                authDir: "/tmp/default-auth",
              },
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(result.cfg.channels?.whatsapp?.accounts?.Default?.authDir).toBe("/tmp/default-auth");
    expect(result.cfg.channels?.whatsapp?.accounts?.Default?.dmPolicy).toBe("open");
    expect(result.cfg.channels?.whatsapp?.accounts?.Default?.allowFrom).toEqual(["*"]);
    expect(result.cfg.channels?.whatsapp?.accounts?.default).toBeUndefined();
  });

  it("heartbeat readiness uses configured defaultAccount for active listener checks", async () => {
    const result = await checkWhatsAppHeartbeatReady({
      cfg: {
        channels: {
          whatsapp: {
            defaultAccount: "work",
            accounts: {
              work: {
                authDir: "/tmp/work",
              },
            },
          },
        },
      } as OpenClawConfig,
      deps: {
        readWebAuthExistsForDecision: async () => ({
          outcome: "stable" as const,
          exists: true,
        }),
        hasActiveWebListener: (accountId?: string) => accountId === "work",
      },
    });

    expect(result).toEqual({ ok: true, reason: "ok" });
  });

  it("heartbeat readiness honors the channel disable flag", async () => {
    const result = await checkWhatsAppHeartbeatReady({
      cfg: { channels: { whatsapp: { enabled: false } } } as OpenClawConfig,
      deps: {
        readWebAuthExistsForDecision: async () => ({
          outcome: "stable" as const,
          exists: true,
        }),
        hasActiveWebListener: () => true,
      },
    });

    expect(result).toEqual({ ok: false, reason: "whatsapp-disabled" });
  });

  it("heartbeat readiness returns unstable when auth state timing is unresolved", async () => {
    const result = await checkWhatsAppHeartbeatReady({
      cfg: {
        channels: {
          whatsapp: {
            accounts: {
              default: {
                authDir: "/tmp/default",
              },
            },
          },
        },
      } as OpenClawConfig,
      deps: {
        readWebAuthExistsForDecision: async () => ({ outcome: "unstable" as const }),
        hasActiveWebListener: () => true,
      },
    });

    expect(result).toEqual({ ok: false, reason: WHATSAPP_AUTH_UNSTABLE_CODE });
  });

  it("keeps config distinct from indeterminate linkage", async () => {
    hoisted.readWebAuthState.mockResolvedValueOnce("unstable");
    const account = {
      authDir: "/tmp/work",
    } as never;

    expect(whatsappSetupPlugin.config.isConfigured?.(account, {} as never)).toBe(true);
    await expect(whatsappSetupPlugin.config.isLinked?.(account, {} as never)).resolves.toBe(
      "unknown",
    );
  });
});
