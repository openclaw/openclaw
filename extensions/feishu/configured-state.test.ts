import { createRequire } from "node:module";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { hasConfiguredFeishuChannelState } from "./configured-state.js";

describe("Feishu lightweight configured-state", () => {
  it("declares the account owner as the package configured-state checker", () => {
    const manifest = createRequire(import.meta.url)("./package.json") as {
      openclaw: { channel: { configuredState: unknown } };
    };

    expect(manifest.openclaw.channel.configuredState).toEqual({
      specifier: "./configured-state",
      exportName: "hasConfiguredFeishuChannelState",
    });
  });

  it("rejects bare environment credentials without configured account references", () => {
    expect(
      hasConfiguredFeishuChannelState({
        cfg: {},
        env: {
          FEISHU_APP_ID: "feishu-app",
          FEISHU_APP_SECRET: "feishu-secret",
        },
      }),
    ).toBe(false);
  });

  it("recognizes explicitly configured top-level app credentials", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: { appId: "feishu-app", appSecret: "feishu-secret" },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(true);
  });

  it("recognizes explicitly configured environment secret references", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          appId: { source: "env", provider: "default", id: "FEISHU_APP_ID" },
          appSecret: { source: "env", provider: "default", id: "FEISHU_APP_SECRET" },
        },
      },
    };

    expect(
      hasConfiguredFeishuChannelState({
        cfg,
        env: {
          FEISHU_APP_ID: "feishu-app",
          FEISHU_APP_SECRET: "feishu-secret",
        },
      }),
    ).toBe(true);
  });

  it("rejects a configured app ID without an app secret", () => {
    const cfg: OpenClawConfig = { channels: { feishu: { appId: "feishu-app" } } };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(false);
  });

  it("rejects a configured app secret without an app ID", () => {
    const cfg: OpenClawConfig = { channels: { feishu: { appSecret: "feishu-secret" } } };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(false);
  });

  it("rejects whitespace-only configured app credentials", () => {
    const cfg: OpenClawConfig = {
      channels: { feishu: { appId: "   ", appSecret: "feishu-secret" } },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(false);
  });

  it("recognizes credentials on a named Feishu account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          accounts: {
            work: { appId: "feishu-work", appSecret: "feishu-work-secret" },
          },
        },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(true);
  });

  it("recognizes named-account credentials inherited from the base config", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          appId: "feishu-app",
          accounts: {
            work: { appSecret: "feishu-work-secret" },
          },
        },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(true);
  });

  it("rejects complete credentials belonging only to a disabled named account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          accounts: {
            work: {
              enabled: false,
              appId: "feishu-work",
              appSecret: "feishu-work-secret",
            },
          },
        },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(false);
  });

  it("does not activate when only a disabled named account completes base credentials", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          appId: "feishu-base",
          accounts: {
            work: { enabled: false, appSecret: "feishu-work-secret" },
          },
        },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(false);
  });

  it("recognizes an enabled named account when another named account is disabled", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          accounts: {
            disabled: {
              enabled: false,
              appId: "feishu-disabled",
              appSecret: "feishu-disabled-secret",
            },
            enabled: { appId: "feishu-active", appSecret: "feishu-active-secret" },
          },
        },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(true);
  });

  it("rejects root credentials shadowed by an explicitly disabled default account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          appId: "feishu-root",
          appSecret: "feishu-root-secret",
          accounts: { default: { enabled: false } },
        },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(false);
  });

  it("rejects direct credentials on an explicitly disabled default account", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          accounts: {
            default: {
              enabled: false,
              appId: "feishu-default",
              appSecret: "feishu-default-secret",
            },
          },
        },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(false);
  });

  it("recognizes active named credentials beside an explicitly disabled default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          appId: "feishu-shared",
          accounts: {
            default: { enabled: false },
            work: { appSecret: "feishu-work-secret" },
          },
        },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(true);
  });

  it("rejects an explicitly disabled channel with complete credentials", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: { enabled: false, appId: "feishu-app", appSecret: "feishu-secret" },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(false);
  });

  it("rejects an explicit default that clears its inherited Feishu app ID", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          appId: "feishu-root",
          appSecret: "feishu-root-secret",
          accounts: { default: { appId: "" } },
        },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(false);
  });

  it("rejects an explicit default that clears its inherited Feishu app secret", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          appId: "feishu-root",
          appSecret: "feishu-root-secret",
          accounts: { default: { appSecret: "" } },
        },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(false);
  });

  it("recognizes an enabled named account beside an invalid merged Feishu default", () => {
    const cfg: OpenClawConfig = {
      channels: {
        feishu: {
          appId: "feishu-root",
          appSecret: "feishu-root-secret",
          accounts: {
            default: { appSecret: "" },
            work: { appSecret: "feishu-work-secret" },
          },
        },
      },
    };

    expect(hasConfiguredFeishuChannelState({ cfg, env: {} })).toBe(true);
  });
});
