import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSendCfgThreadingRuntime,
  expectProvidedCfgSkipsRuntimeLoad,
  expectRuntimeCfgFallback,
} from "../../../test/helpers/extensions/send-config.js";
import { createStartAccountContext } from "../../../test/helpers/extensions/start-account-context.js";
import {
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "../../../test/helpers/extensions/start-account-lifecycle.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import type { CoreConfig } from "./types.js";

vi.mock("../../../src/config/bundled-channel-config-runtime.js", () => ({
  getBundledChannelRuntimeMap: () => new Map(),
  getBundledChannelConfigSchemaMap: () => new Map(),
}));

vi.mock("../../../src/channels/plugins/bundled.js", () => ({
  bundledChannelPlugins: [],
  bundledChannelSetupPlugins: [],
}));

const hoisted = vi.hoisted(() => ({
  monitorNextcloudTalkProvider: vi.fn(),
  loadConfig: vi.fn(),
  resolveMarkdownTableMode: vi.fn(() => "preserve"),
  convertMarkdownTables: vi.fn((text: string) => text),
  record: vi.fn(),
  resolveNextcloudTalkAccount: vi.fn(),
  generateNextcloudTalkSignature: vi.fn(() => ({
    random: "r",
    signature: "s",
  })),
  mockFetchGuard: vi.fn(),
}));

vi.mock("./monitor.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor.js")>("./monitor.js");
  return {
    ...actual,
    monitorNextcloudTalkProvider: hoisted.monitorNextcloudTalkProvider,
  };
});

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return {
    ...actual,
    getNextcloudTalkRuntime: () => createSendCfgThreadingRuntime(hoisted),
  };
});

vi.mock("./accounts.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./accounts.js")>();
  return {
    ...actual,
    resolveNextcloudTalkAccount: hoisted.resolveNextcloudTalkAccount,
  };
});

vi.mock("./signature.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./signature.js")>();
  return {
    ...actual,
    generateNextcloudTalkSignature: hoisted.generateNextcloudTalkSignature,
  };
});

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    fetchWithSsrFGuard: hoisted.mockFetchGuard,
  };
});

vi.mock("../../../src/infra/net/fetch-guard.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    fetchWithSsrFGuard: hoisted.mockFetchGuard,
  };
});

vi.mock("openclaw/plugin-sdk/config-runtime", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    resolveMarkdownTableMode: hoisted.resolveMarkdownTableMode,
  };
});

vi.mock("openclaw/plugin-sdk/text-runtime", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    convertMarkdownTables: hoisted.convertMarkdownTables,
  };
});

const accountsActual = await vi.importActual<typeof import("./accounts.js")>("./accounts.js");
hoisted.resolveNextcloudTalkAccount.mockImplementation(accountsActual.resolveNextcloudTalkAccount);

let resolveNextcloudTalkAccount: typeof import("./accounts.js").resolveNextcloudTalkAccount;
let nextcloudTalkPlugin: typeof import("./channel.js").nextcloudTalkPlugin;
let clearNextcloudTalkAccountFields: typeof import("./setup-core.js").clearNextcloudTalkAccountFields;
let nextcloudTalkDmPolicy: typeof import("./setup-core.js").nextcloudTalkDmPolicy;
let nextcloudTalkSetupAdapter: typeof import("./setup-core.js").nextcloudTalkSetupAdapter;
let normalizeNextcloudTalkBaseUrl: typeof import("./setup-core.js").normalizeNextcloudTalkBaseUrl;
let setNextcloudTalkAccountConfig: typeof import("./setup-core.js").setNextcloudTalkAccountConfig;
let validateNextcloudTalkBaseUrl: typeof import("./setup-core.js").validateNextcloudTalkBaseUrl;
let nextcloudTalkSetupWizard: typeof import("./setup-surface.js").nextcloudTalkSetupWizard;
let sendMessageNextcloudTalk: typeof import("./send.js").sendMessageNextcloudTalk;
let sendReactionNextcloudTalk: typeof import("./send.js").sendReactionNextcloudTalk;

function buildAccount(): ResolvedNextcloudTalkAccount {
  return {
    accountId: "default",
    enabled: true,
    baseUrl: "https://nextcloud.example.com",
    secret: "secret", // pragma: allowlist secret
    secretSource: "config", // pragma: allowlist secret
    config: {
      baseUrl: "https://nextcloud.example.com",
      botSecret: "secret", // pragma: allowlist secret
      webhookPath: "/nextcloud-talk-webhook",
      webhookPort: 8788,
    },
  };
}

function mockStartedMonitor() {
  const stop = vi.fn();
  hoisted.monitorNextcloudTalkProvider.mockResolvedValue({ stop });
  return stop;
}

function startNextcloudAccount(abortSignal?: AbortSignal) {
  return nextcloudTalkPlugin.gateway!.startAccount!(
    createStartAccountContext({
      account: buildAccount(),
      abortSignal,
    }),
  );
}

describe("nextcloud talk setup", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ resolveNextcloudTalkAccount } = await import("./accounts.js"));
    ({ nextcloudTalkPlugin } = await import("./channel.js"));
    ({
      clearNextcloudTalkAccountFields,
      nextcloudTalkDmPolicy,
      nextcloudTalkSetupAdapter,
      normalizeNextcloudTalkBaseUrl,
      setNextcloudTalkAccountConfig,
      validateNextcloudTalkBaseUrl,
    } = await import("./setup-core.js"));
    ({ nextcloudTalkSetupWizard } = await import("./setup-surface.js"));
    ({ sendMessageNextcloudTalk, sendReactionNextcloudTalk } = await import("./send.js"));
    hoisted.resolveNextcloudTalkAccount.mockImplementation(
      accountsActual.resolveNextcloudTalkAccount,
    );
  });

  afterEach(() => {
    vi.clearAllMocks();
    hoisted.resolveNextcloudTalkAccount.mockImplementation(
      accountsActual.resolveNextcloudTalkAccount,
    );
  });

  it("normalizes and validates base urls", () => {
    expect(normalizeNextcloudTalkBaseUrl(" https://cloud.example.com/// ")).toBe(
      "https://cloud.example.com",
    );
    expect(normalizeNextcloudTalkBaseUrl(undefined)).toBe("");

    expect(validateNextcloudTalkBaseUrl("")).toBe("Required");
    expect(validateNextcloudTalkBaseUrl("cloud.example.com")).toBe(
      "URL must start with http:// or https://",
    );
    expect(validateNextcloudTalkBaseUrl("https://cloud.example.com")).toBeUndefined();
  });

  it("patches scoped account config and clears selected fields", () => {
    const cfg: CoreConfig = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecret: "top-secret",
          accounts: {
            work: {
              botSecret: "work-secret",
              botSecretFile: "/tmp/work-secret",
              apiPassword: "api-secret",
            },
          },
        },
      },
    };

    expect(
      setNextcloudTalkAccountConfig(cfg, DEFAULT_ACCOUNT_ID, {
        apiUser: "bot",
      }),
    ).toMatchObject({
      channels: {
        "nextcloud-talk": {
          apiUser: "bot",
        },
      },
    });

    expect(clearNextcloudTalkAccountFields(cfg, DEFAULT_ACCOUNT_ID, ["botSecret"])).toMatchObject({
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
        },
      },
    });
    expect(
      clearNextcloudTalkAccountFields(cfg, DEFAULT_ACCOUNT_ID, ["botSecret"]),
    ).not.toMatchObject({
      channels: {
        "nextcloud-talk": {
          botSecret: expect.anything(),
        },
      },
    });

    expect(
      clearNextcloudTalkAccountFields(cfg, "work", ["botSecret", "botSecretFile"]),
    ).toMatchObject({
      channels: {
        "nextcloud-talk": {
          accounts: {
            work: {
              apiPassword: "api-secret",
            },
          },
        },
      },
    });
  });

  it("sets top-level DM policy state", async () => {
    const base: CoreConfig = {
      channels: {
        "nextcloud-talk": {},
      },
    };

    expect(nextcloudTalkDmPolicy.getCurrent(base)).toBe("pairing");
    expect(nextcloudTalkDmPolicy.setPolicy(base, "open")).toMatchObject({
      channels: {
        "nextcloud-talk": {
          dmPolicy: "open",
        },
      },
    });
  });

  it("validates env/default-account constraints and applies config patches", () => {
    const validateInput = nextcloudTalkSetupAdapter.validateInput;
    const applyAccountConfig = nextcloudTalkSetupAdapter.applyAccountConfig;
    expect(validateInput).toBeTypeOf("function");
    expect(applyAccountConfig).toBeTypeOf("function");

    expect(
      validateInput!({
        accountId: "work",
        input: { useEnv: true },
      } as never),
    ).toBe("NEXTCLOUD_TALK_BOT_SECRET can only be used for the default account.");

    expect(
      validateInput!({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, baseUrl: "", secret: "" },
      } as never),
    ).toBe("Nextcloud Talk requires bot secret or --secret-file (or --use-env).");

    expect(
      validateInput!({
        accountId: DEFAULT_ACCOUNT_ID,
        input: { useEnv: false, secret: "secret", baseUrl: "" },
      } as never),
    ).toBe("Nextcloud Talk requires --base-url.");

    expect(
      applyAccountConfig!({
        cfg: {
          channels: {
            "nextcloud-talk": {},
          },
        },
        accountId: DEFAULT_ACCOUNT_ID,
        input: {
          name: "Default",
          baseUrl: "https://cloud.example.com///",
          secret: "bot-secret",
        },
      } as never),
    ).toEqual({
      channels: {
        "nextcloud-talk": {
          enabled: true,
          name: "Default",
          baseUrl: "https://cloud.example.com",
          botSecret: "bot-secret",
        },
      },
    });

    expect(
      applyAccountConfig!({
        cfg: {
          channels: {
            "nextcloud-talk": {
              accounts: {
                work: {
                  botSecret: "old-secret",
                },
              },
            },
          },
        },
        accountId: "work",
        input: {
          name: "Work",
          useEnv: true,
          baseUrl: "https://cloud.example.com",
        },
      } as never),
    ).toMatchObject({
      channels: {
        "nextcloud-talk": {
          accounts: {
            work: {
              enabled: true,
              name: "Work",
              baseUrl: "https://cloud.example.com",
            },
          },
        },
      },
    });
  });

  it("clears stored bot secret fields when switching the default account to env", () => {
    type ApplyAccountConfigContext = Parameters<
      typeof nextcloudTalkSetupAdapter.applyAccountConfig
    >[0];

    const next = nextcloudTalkSetupAdapter.applyAccountConfig({
      cfg: {
        channels: {
          "nextcloud-talk": {
            enabled: true,
            baseUrl: "https://cloud.old.example",
            botSecret: "stored-secret",
            botSecretFile: "/tmp/secret.txt",
          },
        },
      },
      accountId: DEFAULT_ACCOUNT_ID,
      input: {
        baseUrl: "https://cloud.example.com",
        useEnv: true,
      },
    } as unknown as ApplyAccountConfigContext);

    expect(next.channels?.["nextcloud-talk"]?.baseUrl).toBe("https://cloud.example.com");
    expect(next.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecret");
    expect(next.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecretFile");
  });

  it("clears stored bot secret fields when the wizard switches to env", async () => {
    const credential = nextcloudTalkSetupWizard.credentials[0];
    const next = await credential.applyUseEnv?.({
      cfg: {
        channels: {
          "nextcloud-talk": {
            enabled: true,
            baseUrl: "https://cloud.example.com",
            botSecret: "stored-secret",
            botSecretFile: "/tmp/secret.txt",
          },
        },
      },
      accountId: DEFAULT_ACCOUNT_ID,
    });

    expect(next?.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecret");
    expect(next?.channels?.["nextcloud-talk"]).not.toHaveProperty("botSecretFile");
  });

  it("keeps startAccount pending until abort, then stops the monitor", async () => {
    const stop = mockStartedMonitor();
    const { abort, task, isSettled } = startAccountAndTrackLifecycle({
      startAccount: nextcloudTalkPlugin.gateway!.startAccount!,
      account: buildAccount(),
    });
    await expectStopPendingUntilAbort({
      waitForStarted: waitForStartedMocks(hoisted.monitorNextcloudTalkProvider),
      isSettled,
      abort,
      task,
      stop,
    });
  });

  it("stops immediately when startAccount receives an already-aborted signal", async () => {
    const stop = mockStartedMonitor();
    const abort = new AbortController();
    abort.abort();

    await startNextcloudAccount(abort.signal);

    expect(hoisted.monitorNextcloudTalkProvider).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});

describe("resolveNextcloudTalkAccount", () => {
  it("matches normalized configured account ids", () => {
    const account = resolveNextcloudTalkAccount({
      cfg: {
        channels: {
          "nextcloud-talk": {
            accounts: {
              "Ops Team": {
                baseUrl: "https://cloud.example.com",
                botSecret: "bot-secret",
              },
            },
          },
        },
      } as CoreConfig,
      accountId: "ops-team",
    });

    expect(account.accountId).toBe("ops-team");
    expect(account.baseUrl).toBe("https://cloud.example.com");
    expect(account.secret).toBe("bot-secret");
    expect(account.secretSource).toBe("config");
  });

  it.runIf(process.platform !== "win32")("rejects symlinked botSecretFile paths", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-nextcloud-talk-"));
    const secretFile = path.join(dir, "secret.txt");
    const secretLink = path.join(dir, "secret-link.txt");
    fs.writeFileSync(secretFile, "bot-secret\n", "utf8");
    fs.symlinkSync(secretFile, secretLink);

    const cfg = {
      channels: {
        "nextcloud-talk": {
          baseUrl: "https://cloud.example.com",
          botSecretFile: secretLink,
        },
      },
    } as CoreConfig;

    const account = resolveNextcloudTalkAccount({ cfg });
    expect(account.secret).toBe("");
    expect(account.secretSource).toBe("none");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("nextcloud-talk send cfg threading", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(async () => {
    vi.resetModules();
    ({ sendMessageNextcloudTalk, sendReactionNextcloudTalk } = await import("./send.js"));
    vi.stubGlobal("fetch", fetchMock);
    // Wire the SSRF guard mock to delegate to the global fetch mock
    hoisted.mockFetchGuard.mockImplementation(async (p: { url: string; init?: RequestInit }) => {
      const response = await globalThis.fetch(p.url, p.init);
      return { response, release: async () => {}, finalUrl: p.url };
    });
    hoisted.resolveNextcloudTalkAccount.mockImplementation(
      accountsActual.resolveNextcloudTalkAccount,
    );
  });

  afterEach(() => {
    fetchMock.mockReset();
    hoisted.mockFetchGuard.mockReset();
    vi.unstubAllGlobals();
  });

  it("uses provided cfg for sendMessage and skips runtime loadConfig", async () => {
    const cfg = { source: "provided" } as const;
    hoisted.resolveNextcloudTalkAccount.mockReturnValue({
      accountId: "default",
      baseUrl: "https://nextcloud.example.com",
      secret: "secret-value", // pragma: allowlist secret
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ocs: { data: { id: 12345, timestamp: 1_706_000_000 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await sendMessageNextcloudTalk("room:abc123", "hello", {
      cfg,
      accountId: "work",
    });

    expectProvidedCfgSkipsRuntimeLoad({
      loadConfig: hoisted.loadConfig,
      resolveAccount: hoisted.resolveNextcloudTalkAccount,
      cfg,
      accountId: "work",
    });
    expect(hoisted.resolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg,
      channel: "nextcloud-talk",
      accountId: "default",
    });
    expect(hoisted.convertMarkdownTables).toHaveBeenCalledWith("hello", "preserve");
    expect(hoisted.record).toHaveBeenCalledWith({
      channel: "nextcloud-talk",
      accountId: "default",
      direction: "outbound",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      messageId: "12345",
      roomToken: "abc123",
      timestamp: 1_706_000_000,
    });
  });

  it("sends with provided cfg even when the runtime store is not initialized", async () => {
    const cfg = { source: "provided" } as const;
    hoisted.resolveNextcloudTalkAccount.mockReturnValue({
      accountId: "default",
      baseUrl: "https://nextcloud.example.com",
      secret: "secret-value",
    });
    hoisted.record.mockImplementation(() => {
      throw new Error("Nextcloud Talk runtime not initialized");
    });
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ocs: { data: { id: 12346, timestamp: 1_706_000_001 } },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    const result = await sendMessageNextcloudTalk("room:abc123", "hello", {
      cfg,
      accountId: "work",
    });

    expectProvidedCfgSkipsRuntimeLoad({
      loadConfig: hoisted.loadConfig,
      resolveAccount: hoisted.resolveNextcloudTalkAccount,
      cfg,
      accountId: "work",
    });
    expect(hoisted.resolveMarkdownTableMode).toHaveBeenCalledWith({
      cfg,
      channel: "nextcloud-talk",
      accountId: "default",
    });
    expect(hoisted.convertMarkdownTables).toHaveBeenCalledWith("hello", "preserve");
    expect(result).toEqual({
      messageId: "12346",
      roomToken: "abc123",
      timestamp: 1_706_000_001,
    });
  });

  it("falls back to runtime cfg for sendReaction when cfg is omitted", async () => {
    const runtimeCfg = { source: "runtime" } as const;
    hoisted.loadConfig.mockReturnValueOnce(runtimeCfg);
    hoisted.resolveNextcloudTalkAccount.mockReturnValue({
      accountId: "default",
      baseUrl: "https://nextcloud.example.com",
      secret: "secret-value", // pragma: allowlist secret
    });
    fetchMock.mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await sendReactionNextcloudTalk("room:ops", "m-1", "👍", {
      accountId: "default",
    });

    expect(result).toEqual({ ok: true });
    expectRuntimeCfgFallback({
      loadConfig: hoisted.loadConfig,
      resolveAccount: hoisted.resolveNextcloudTalkAccount,
      cfg: runtimeCfg,
      accountId: "default",
    });
  });
});
