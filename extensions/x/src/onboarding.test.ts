import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import { xSetupWizard } from "./onboarding.js";
import { setXRuntime } from "./runtime.js";

function createPrompter(params: { confirmValue: boolean; textValues: string[] }): WizardPrompter {
  const queue = [...params.textValues];
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => "") as unknown as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => String(queue.shift() ?? "")),
    confirm: vi.fn(async () => params.confirmValue),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

function setupXRuntime() {
  setXRuntime({
    channel: {
      x: {
        defaultAccountId: "default",
        listXAccountIds: (cfg: OpenClawConfig) =>
          cfg.channels?.x?.accounts ? Object.keys(cfg.channels.x.accounts) : [],
        resolveXAccount: (cfg: OpenClawConfig, accountId?: string | null) => {
          const id = accountId ?? "default";
          const accountFromMap = cfg.channels?.x?.accounts?.[id];
          if (accountFromMap) {
            return accountFromMap;
          }
          if (
            id === "default" &&
            cfg.channels?.x?.consumerKey &&
            cfg.channels?.x?.consumerSecret &&
            cfg.channels?.x?.accessToken &&
            cfg.channels?.x?.accessTokenSecret
          ) {
            return {
              consumerKey: cfg.channels.x.consumerKey,
              consumerSecret: cfg.channels.x.consumerSecret,
              accessToken: cfg.channels.x.accessToken,
              accessTokenSecret: cfg.channels.x.accessTokenSecret,
              enabled: cfg.channels.x.enabled,
              pollIntervalSeconds: cfg.channels.x.pollIntervalSeconds,
              proxy: cfg.channels.x.proxy,
            };
          }
          return null;
        },
        isXAccountConfigured: (
          account: {
            consumerKey?: string;
            consumerSecret?: string;
            accessToken?: string;
            accessTokenSecret?: string;
          } | null,
        ) =>
          Boolean(
            account?.consumerKey &&
            account?.consumerSecret &&
            account?.accessToken &&
            account?.accessTokenSecret,
          ),
      },
    },
  } as never);
}

describe("xSetupWizard", () => {
  beforeEach(() => {
    setupXRuntime();
  });

  it("has a status.resolveConfigured that reports false when credentials are missing", async () => {
    const configured = await xSetupWizard.status.resolveConfigured({
      cfg: {} as OpenClawConfig,
    });
    expect(configured).toBe(false);
  });

  it("has a status.resolveConfigured that reports true when credentials are present", async () => {
    const cfg = {
      channels: {
        x: {
          accounts: {
            default: {
              consumerKey: "ck",
              consumerSecret: "cs",
              accessToken: "at",
              accessTokenSecret: "ats",
            },
          },
        },
      },
    } as unknown as OpenClawConfig;
    const configured = await xSetupWizard.status.resolveConfigured({ cfg });
    expect(configured).toBe(true);
  });

  it("writes default account credentials via finalize", async () => {
    const prompter = createPrompter({
      confirmValue: false,
      textValues: [
        "consumer-key",
        "consumer-secret",
        "access-token",
        "access-token-secret",
        "60",
        "http://127.0.0.1:7890",
        "12345678",
        "12345678",
      ],
    });

    const result = await xSetupWizard.finalize!({
      cfg: {} as OpenClawConfig,
      accountId: "default",
      credentialValues: {},
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter,
      options: undefined,
      forceAllowFrom: false,
    });

    expect(result?.cfg).toBeDefined();
    const nextCfg = result!.cfg!;
    expect(nextCfg.channels?.x?.enabled).toBe(true);
    expect(nextCfg.channels?.x?.consumerKey).toBe("consumer-key");
    expect(nextCfg.channels?.x?.consumerSecret).toBe("consumer-secret");
    expect(nextCfg.channels?.x?.accessToken).toBe("access-token");
    expect(nextCfg.channels?.x?.accessTokenSecret).toBe("access-token-secret");
    expect(nextCfg.channels?.x?.pollIntervalSeconds).toBe(60);
    expect(nextCfg.channels?.x?.proxy).toBe("http://127.0.0.1:7890");
    expect(nextCfg.channels?.x?.allowFrom).toEqual(["12345678"]);
    expect(nextCfg.channels?.x?.actionsAllowFrom).toEqual(["12345678"]);
  });
});
