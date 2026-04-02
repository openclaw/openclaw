import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPluginSetupWizardConfigure,
  createTestWizardPrompter,
  runSetupWizardConfigure,
  type WizardPrompter,
} from "../../../test/helpers/plugins/setup-wizard.js";
import {
  expectLifecyclePatch,
  expectPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "../../../test/helpers/plugins/start-account-lifecycle.js";
import type { OpenClawConfig } from "../runtime-api.js";
import { resolveGoogleChatAccount, type ResolvedGoogleChatAccount } from "./accounts.js";
import { googlechatPlugin } from "./channel.js";
import { googlechatSetupAdapter } from "./setup-core.js";

const hoisted = vi.hoisted(() => ({
  startGoogleChatMonitor: vi.fn(),
}));

vi.mock("./monitor.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor.js")>("./monitor.js");
  return {
    ...actual,
    startGoogleChatMonitor: hoisted.startGoogleChatMonitor,
  };
});

const googlechatConfigure = createPluginSetupWizardConfigure(googlechatPlugin);

function buildAccount(): ResolvedGoogleChatAccount {
  return {
    accountId: "default",
    enabled: true,
    credentialSource: "inline",
    credentials: {},
    config: {
      webhookPath: "/googlechat",
      webhookUrl: "https://example.com/googlechat",
      audienceType: "app-url",
      audience: "https://example.com/googlechat",
    },
  };
}

describe("googlechat setup", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  it("rejects env auth for non-default accounts", () => {
    if (!googlechatSetupAdapter.validateInput) {
      throw new Error("Expected googlechatSetupAdapter.validateInput to be defined");
    }
    expect(
      googlechatSetupAdapter.validateInput({
        accountId: "secondary",
        input: { useEnv: true },
      } as never),
    ).toBe("GOOGLE_CHAT_SERVICE_ACCOUNT env vars can only be used for the default account.");
  });

  it("requires inline or file credentials when env auth is not used", () => {
    if (!googlechatSetupAdapter.validateInput) {
      throw new Error("Expected googlechatSetupAdapter.validateInput to be defined");
    }
    expect(
      googlechatSetupAdapter.validateInput({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, token: "", tokenFile: "" },
      } as never),
    ).toBe("Google Chat requires --token (service account JSON) or --token-file.");
  });

  it("builds a patch from token-file and trims optional webhook fields", () => {
    if (!googlechatSetupAdapter.applyAccountConfig) {
      throw new Error("Expected googlechatSetupAdapter.applyAccountConfig to be defined");
    }
    expect(
      googlechatSetupAdapter.applyAccountConfig({
        cfg: { channels: { googlechat: {} } },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          tokenFile: "/tmp/googlechat.json",
          audienceType: " app-url ",
          audience: " https://example.com/googlechat ",
          webhookPath: " /googlechat ",
          webhookUrl: " https://example.com/googlechat/hook ",
        },
      } as never),
    ).toEqual({
      channels: {
        googlechat: {
          enabled: true,
          name: "Default",
          serviceAccountFile: "/tmp/googlechat.json",
          audienceType: "app-url",
          audience: "https://example.com/googlechat",
          webhookPath: "/googlechat",
          webhookUrl: "https://example.com/googlechat/hook",
        },
      },
    });
  });

  it("prefers inline token patch when token-file is absent", () => {
    if (!googlechatSetupAdapter.applyAccountConfig) {
      throw new Error("Expected googlechatSetupAdapter.applyAccountConfig to be defined");
    }
    expect(
      googlechatSetupAdapter.applyAccountConfig({
        cfg: { channels: { googlechat: {} } },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          token: { client_email: "bot@example.com" },
        },
      } as never),
    ).toEqual({
      channels: {
        googlechat: {
          enabled: true,
          name: "Default",
          serviceAccount: { client_email: "bot@example.com" },
        },
      },
    });
  });

  it("configures service-account auth and webhook audience", async () => {
    const prompter = createTestWizardPrompter({
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

    const result = await runSetupWizardConfigure({
      configure: googlechatConfigure,
      cfg: {} as OpenClawConfig,
      prompter,
      options: {},
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.googlechat?.enabled).toBe(true);
    expect(result.cfg.channels?.googlechat?.serviceAccountFile).toBe(
      "/tmp/googlechat-service-account.json",
    );
    expect(result.cfg.channels?.googlechat?.audienceType).toBe("app-url");
    expect(result.cfg.channels?.googlechat?.audience).toBe("https://example.com/googlechat");
  });

  it("keeps startAccount pending until abort, then unregisters", async () => {
    const unregister = vi.fn();
    hoisted.startGoogleChatMonitor.mockResolvedValue(unregister);

    const { abort, patches, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: googlechatPlugin.gateway!.startAccount!,
      account: buildAccount(),
    });
    await expectPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.startGoogleChatMonitor),
      isSettled,
      abort,
      task,
      assertBeforeAbort: () => {
        expect(unregister).not.toHaveBeenCalled();
      },
      assertAfterAbort: () => {
        expect(unregister).toHaveBeenCalledOnce();
      },
    });
    expectLifecyclePatch(patches, { running: true });
    expectLifecyclePatch(patches, { running: false });
  });
});

describe("resolveGoogleChatAccount", () => {
  it("parses default-account env JSON credentials only when they decode to an object", () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '{"client_email":"bot@example.com"}');

    const resolved = resolveGoogleChatAccount({
      cfg: { channels: { googlechat: {} } },
      accountId: "default",
    });

    expect(resolved.credentialSource).toBe("env");
    expect(resolved.credentials).toEqual({ client_email: "bot@example.com" });
  });

  it("ignores env JSON credentials when they decode to a non-object value", () => {
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT", '["not","an","object"]');
    vi.stubEnv("GOOGLE_CHAT_SERVICE_ACCOUNT_FILE", "/tmp/googlechat.json");

    const resolved = resolveGoogleChatAccount({
      cfg: { channels: { googlechat: {} } },
      accountId: "default",
    });

    expect(resolved.credentialSource).toBe("env");
    expect(resolved.credentials).toBeUndefined();
    expect(resolved.credentialsFile).toBe("/tmp/googlechat.json");
  });

  it("inherits shared defaults from accounts.default for named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
              webhookPath: "/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.config.audienceType).toBe("app-url");
    expect(resolved.config.audience).toBe("https://example.com/googlechat");
    expect(resolved.config.webhookPath).toBe("/googlechat");
    expect(resolved.config.serviceAccountFile).toBe("/tmp/andy-sa.json");
  });

  it("prefers top-level and account overrides over accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          audienceType: "project-number",
          audience: "1234567890",
          accounts: {
            default: {
              audienceType: "app-url",
              audience: "https://default.example.com/googlechat",
              webhookPath: "/googlechat-default",
            },
            april: {
              webhookPath: "/googlechat-april",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "april" });
    expect(resolved.config.audienceType).toBe("project-number");
    expect(resolved.config.audience).toBe("1234567890");
    expect(resolved.config.webhookPath).toBe("/googlechat-april");
  });

  it("does not inherit disabled state from accounts.default for named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              enabled: false,
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.enabled).toBe(true);
    expect(resolved.config.enabled).toBeUndefined();
    expect(resolved.config.audienceType).toBe("app-url");
  });

  it("does not inherit default-account credentials into named accounts", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              serviceAccountRef: {
                source: "env",
                provider: "test",
                id: "default-sa",
              },
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.credentialSource).toBe("file");
    expect(resolved.credentialsFile).toBe("/tmp/andy-sa.json");
    expect(resolved.config.audienceType).toBe("app-url");
  });

  it("does not inherit dangerous name matching from accounts.default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        googlechat: {
          accounts: {
            default: {
              dangerouslyAllowNameMatching: true,
              audienceType: "app-url",
              audience: "https://example.com/googlechat",
            },
            andy: {
              serviceAccountFile: "/tmp/andy-sa.json",
            },
          },
        },
      },
    };

    const resolved = resolveGoogleChatAccount({ cfg, accountId: "andy" });
    expect(resolved.config.dangerouslyAllowNameMatching).toBeUndefined();
    expect(resolved.config.audienceType).toBe("app-url");
  });
});
