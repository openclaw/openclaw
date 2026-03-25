import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/routing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createStartAccountContext } from "../../../test/helpers/extensions/start-account-context.js";
import {
  expectStopPendingUntilAbort,
  startAccountAndTrackLifecycle,
  waitForStartedMocks,
} from "../../../test/helpers/extensions/start-account-lifecycle.js";
import type { ResolvedNextcloudTalkAccount } from "./accounts.js";
import { nextcloudTalkPlugin } from "./channel.js";
import {
  clearNextcloudTalkAccountFields,
  nextcloudTalkDmPolicy,
  nextcloudTalkSetupAdapter,
  normalizeNextcloudTalkBaseUrl,
  setNextcloudTalkAccountConfig,
  validateNextcloudTalkBaseUrl,
} from "./setup-core.js";
import { nextcloudTalkSetupWizard } from "./setup-surface.js";
import type { CoreConfig } from "./types.js";

const hoisted = vi.hoisted(() => ({
  monitorNextcloudTalkProvider: vi.fn(),
}));

vi.mock("./monitor.js", async () => {
  const actual = await vi.importActual<typeof import("./monitor.js")>("./monitor.js");
  return {
    ...actual,
    monitorNextcloudTalkProvider: hoisted.monitorNextcloudTalkProvider,
  };
});

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
  afterEach(() => {
    vi.clearAllMocks();
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
