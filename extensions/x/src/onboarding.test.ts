import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import type { WizardPrompter } from "../../../src/wizard/prompts.js";
import { xOnboardingAdapter } from "./onboarding.js";
import { setXRuntime } from "./runtime.js";

function createPrompter(params: { confirmValue: boolean; textValues: string[] }): WizardPrompter {
  const queue = [...params.textValues];
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(async () => ""),
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => String(queue.shift() ?? "")),
    confirm: vi.fn(async () => params.confirmValue),
    progress: vi.fn(() => ({ update: vi.fn(), stop: vi.fn() })),
  };
}

describe("xOnboardingAdapter", () => {
  beforeEach(() => {
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
  });

  it("reports unconfigured status when credentials are missing", async () => {
    const status = await xOnboardingAdapter.getStatus({
      cfg: {} as OpenClawConfig,
      accountOverrides: {},
    });

    expect(status.configured).toBe(false);
    expect(status.channel).toBe("x");
  });

  it("writes default account credentials to channels.x config", async () => {
    const prompter = createPrompter({
      confirmValue: false,
      textValues: [
        "consumer-key",
        "consumer-secret",
        "access-token",
        "access-token-secret",
        "60",
        "http://127.0.0.1:7890",
      ],
    });

    const result = await xOnboardingAdapter.configure({
      cfg: {} as OpenClawConfig,
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      prompter,
      accountOverrides: {},
      shouldPromptAccountIds: false,
      forceAllowFrom: false,
    });

    expect(result.accountId).toBe("default");
    expect(result.cfg.channels?.x?.enabled).toBe(true);
    expect(result.cfg.channels?.x?.consumerKey).toBe("consumer-key");
    expect(result.cfg.channels?.x?.consumerSecret).toBe("consumer-secret");
    expect(result.cfg.channels?.x?.accessToken).toBe("access-token");
    expect(result.cfg.channels?.x?.accessTokenSecret).toBe("access-token-secret");
    expect(result.cfg.channels?.x?.pollIntervalSeconds).toBe(60);
    expect(result.cfg.channels?.x?.proxy).toBe("http://127.0.0.1:7890");
  });
});
