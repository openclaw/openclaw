// Mattermost tests cover setup plugin behavior.
import {
  createSetupWizardAdapter,
  createQueuedWizardPrompter,
  runSetupWizardConfigure,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/setup";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";

const normalizeMattermostBaseUrl = vi.hoisted(() => vi.fn((value: string | undefined) => value));
const hasConfiguredSecretInput = vi.hoisted(() => vi.fn((value: unknown) => Boolean(value)));

vi.mock("./setup.accounts.runtime.js", () => {
  const resolveAccount = (params: { cfg: OpenClawConfig; accountId?: string }) => ({
    accountId: params.accountId ?? DEFAULT_ACCOUNT_ID,
    enabled: params.cfg.channels?.mattermost?.enabled !== false,
    botToken:
      typeof params.cfg.channels?.mattermost?.botToken === "string"
        ? params.cfg.channels.mattermost.botToken
        : undefined,
    baseUrl: normalizeMattermostBaseUrl(params.cfg.channels?.mattermost?.baseUrl),
    botTokenSource:
      typeof params.cfg.channels?.mattermost?.botToken === "string" ? "config" : "none",
    botTokenStatus:
      typeof params.cfg.channels?.mattermost?.botToken === "string" ? "available" : "missing",
    baseUrlSource: params.cfg.channels?.mattermost?.baseUrl ? "config" : "none",
    config: params.cfg.channels?.mattermost ?? {},
  });
  return {
    listMattermostAccountIds: vi.fn((cfg: OpenClawConfig) => {
      const accounts = cfg.channels?.mattermost?.accounts;
      const ids = accounts ? Object.keys(accounts) : [];
      return ids.length > 0 ? ids : [DEFAULT_ACCOUNT_ID];
    }),
    inspectMattermostAccount: resolveAccount,
    resolveMattermostAccount: resolveAccount,
  };
});

vi.mock("./setup.client.runtime.js", () => ({
  normalizeMattermostBaseUrl,
}));

vi.mock("./setup.secret-input.runtime.js", () => ({
  hasConfiguredSecretInput,
}));

let mattermostSetupWizard: typeof import("./setup-surface.js").mattermostSetupWizard;
let isMattermostConfigured: typeof import("./setup-core.js").isMattermostConfigured;
let mattermostSetupAdapter: typeof import("./setup-core.js").mattermostSetupAdapter;

describe("mattermost setup", () => {
  beforeAll(async () => {
    ({ mattermostSetupWizard } = await import("./setup-surface.js"));
    ({ isMattermostConfigured, mattermostSetupAdapter } = await import("./setup-core.js"));
  });

  beforeEach(() => {
    registerEnvDefaults();
  });

  afterEach(() => {
    normalizeMattermostBaseUrl.mockReset();
    normalizeMattermostBaseUrl.mockImplementation((value: string | undefined) => value);
    hasConfiguredSecretInput.mockReset();
    hasConfiguredSecretInput.mockImplementation((value: unknown) => Boolean(value));
    vi.unstubAllEnvs();
  });

  it("reports configuration only when token and base url are both present", () => {
    expect(
      isMattermostConfigured({
        botToken: "bot-token",
        baseUrl: "https://chat.example.com",
        config: {},
      } as never),
    ).toBe(true);

    expect(
      isMattermostConfigured({
        botToken: "",
        baseUrl: "https://chat.example.com",
        config: { botToken: "secret-ref" },
      } as never),
    ).toBe(true);

    expect(
      isMattermostConfigured({
        botToken: "",
        baseUrl: "",
        config: {},
      } as never),
    ).toBe(false);
  });

  it("validates env and explicit credential requirements", () => {
    const validateInput = mattermostSetupAdapter.validateInput;
    expect(validateInput).toBeTypeOf("function");
    if (!validateInput) {
      throw new Error("Expected Mattermost setup validateInput");
    }

    expect(
      validateInput({
        accountId: "secondary",
        input: { useEnv: true },
      } as never),
    ).toBe("Mattermost env vars can only be used for the default account.");

    normalizeMattermostBaseUrl.mockReturnValue(undefined);
    expect(
      validateInput({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, botToken: "tok", httpUrl: "not-a-url" },
      } as never),
    ).toBe("Mattermost requires --bot-token and --http-url (or --use-env).");

    normalizeMattermostBaseUrl.mockReturnValue("https://chat.example.com");
    expect(
      validateInput({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, botToken: "tok", httpUrl: "https://chat.example.com" },
      } as never),
    ).toBeNull();
  });

  it("applies normalized config for default and named accounts", () => {
    normalizeMattermostBaseUrl.mockReturnValue("https://chat.example.com");
    const applyAccountConfig = mattermostSetupAdapter.applyAccountConfig;
    expect(applyAccountConfig).toBeTypeOf("function");

    expect(
      applyAccountConfig({
        cfg: { channels: { mattermost: {} } },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          botToken: "tok",
          httpUrl: "https://chat.example.com",
        },
      } as never),
    ).toEqual({
      channels: {
        mattermost: {
          enabled: true,
          name: "Default",
          botToken: "tok",
          baseUrl: "https://chat.example.com",
        },
      },
    });

    expect(
      applyAccountConfig({
        cfg: {
          channels: {
            mattermost: {
              name: "Legacy",
            },
          },
        },
        accountId: "Work Team",
        input: {
          name: "Work",
          botToken: "tok2",
          httpUrl: "https://chat.example.com",
        },
      } as never),
    ).toEqual({
      channels: {
        mattermost: {
          enabled: true,
          accounts: {
            default: {
              name: "Legacy",
            },
            "work-team": {
              enabled: true,
              name: "Work",
              botToken: "tok2",
              baseUrl: "https://chat.example.com",
            },
          },
        },
      },
    });
  });

  it("treats secret-ref tokens plus base url as configured", async () => {
    const configured = await mattermostSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          mattermost: {
            baseUrl: "https://chat.example.com",
            botToken: {
              source: "env",
              provider: "default",
              id: "MATTERMOST_BOT_TOKEN",
            },
          },
        },
      } as OpenClawConfig,
    });

    expect(configured).toBe(true);
  });

  it("does not inherit configured state from a sibling when defaultAccount is named", async () => {
    const configured = await mattermostSetupWizard.status.resolveConfigured({
      cfg: {
        channels: {
          mattermost: {
            defaultAccount: "work",
            accounts: {
              alerts: {
                baseUrl: "https://chat.example.com",
                botToken: {
                  source: "env",
                  provider: "default",
                  id: "MATTERMOST_BOT_TOKEN",
                },
              },
              work: {},
            },
          },
        },
      } as OpenClawConfig,
      accountId: undefined,
    });

    expect(configured).toBe(false);
  });

  it("shows intro note only when the target account is not configured", () => {
    expect(
      mattermostSetupWizard.introNote?.shouldShow?.({
        cfg: {
          channels: {
            mattermost: {},
          },
        } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toBe(true);

    expect(
      mattermostSetupWizard.introNote?.shouldShow?.({
        cfg: {
          channels: {
            mattermost: {
              baseUrl: "https://chat.example.com",
              botToken: {
                source: "env",
                provider: "default",
                id: "MATTERMOST_BOT_TOKEN",
              },
            },
          },
        } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toBe(false);
  });

  it("offers env shortcut only for the default account when env is present and config is empty", () => {
    vi.stubEnv("MATTERMOST_BOT_TOKEN", "bot-token");
    vi.stubEnv("MATTERMOST_URL", "https://chat.example.com");

    expect(
      mattermostSetupWizard.envShortcut?.isAvailable?.({
        cfg: { channels: { mattermost: {} } } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toBe(true);

    expect(
      mattermostSetupWizard.envShortcut?.isAvailable?.({
        cfg: { channels: { mattermost: {} } } as OpenClawConfig,
        accountId: "work",
      } as never),
    ).toBe(false);
  });

  it("keeps env shortcut as a no-op patch for the selected account", () => {
    expect(
      mattermostSetupWizard.envShortcut?.apply?.({
        cfg: { channels: { mattermost: { enabled: false } } } as OpenClawConfig,
        accountId: "default",
      } as never),
    ).toEqual({
      channels: {
        mattermost: {
          enabled: true,
        },
      },
    });
  });

  it("prompts for bot token and server URL before validating wizard setup", async () => {
    normalizeMattermostBaseUrl.mockImplementation((value: string | undefined) =>
      value?.startsWith("http") ? value : undefined,
    );
    const queued = createQueuedWizardPrompter({
      textValues: ["bot-token", "https://chat.example.com"],
    });
    const adapter = createSetupWizardAdapter({
      plugin: {
        id: "mattermost",
        meta: { label: "Mattermost" },
        config: {
          listAccountIds: () => [DEFAULT_ACCOUNT_ID],
        },
        setup: mattermostSetupAdapter,
      } as never,
      wizard: mattermostSetupWizard,
    });

    const result = await runSetupWizardConfigure({
      configure: adapter.configure,
      cfg: { channels: { mattermost: {} } } as OpenClawConfig,
      prompter: queued.prompter,
      options: { secretInputMode: "plaintext" as const },
    });

    const textMessages = queued.text.mock.calls.map(
      ([params]) => (params as { message: string }).message,
    );
    expect(textMessages).toEqual(["Enter Mattermost bot token", "Enter Mattermost base URL"]);
    const mattermostConfig = result.cfg.channels?.mattermost;
    if (!mattermostConfig) {
      throw new Error("expected Mattermost config");
    }
    expect(mattermostConfig.botToken).toBe("bot-token");
    expect(mattermostConfig.baseUrl).toBe("https://chat.example.com");
    expect(result.accountId).toBe(DEFAULT_ACCOUNT_ID);
  });
});

function registerEnvDefaults() {
  vi.unstubAllEnvs();
}
