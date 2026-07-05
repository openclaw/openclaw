// Clickclack tests cover accounts plugin behavior.
import { describe, expect, it } from "vitest";
import {
  listClickClackAccountIds,
  resolveClickClackAccount,
  resolveClickClackRuntimeToken,
  resolveDefaultClickClackAccountId,
} from "./accounts.js";
import type { CoreConfig } from "./types.js";

describe("ClickClack account resolution", () => {
  it("preserves top-level default account when named accounts are configured", () => {
    const cfg = {
      channels: {
        clickclack: {
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          token: "ccb_default",
          accounts: {
            work: { enabled: false },
          },
        },
      },
    } satisfies CoreConfig;

    expect(listClickClackAccountIds(cfg)).toEqual(["default", "work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("default");
    expect(resolveClickClackAccount({ cfg }).token).toBe("ccb_default");
  });

  it("does not synthesize a partial top-level default account from inherited credentials", () => {
    const cfg = {
      channels: {
        clickclack: {
          token: "ccb_shared",
          accounts: {
            work: {
              baseUrl: "https://app.clickclack.chat",
              workspace: "wsp_1",
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(listClickClackAccountIds(cfg)).toEqual(["work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("work");
  });

  it("does not synthesize a default account from blank top-level credentials", () => {
    const cfg = {
      channels: {
        clickclack: {
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_default",
          token: "   ",
          accounts: {
            work: {
              baseUrl: "https://app.clickclack.chat",
              workspace: "wsp_1",
              token: "ccb_work",
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(listClickClackAccountIds(cfg)).toEqual(["work"]);
    expect(resolveDefaultClickClackAccountId(cfg)).toBe("work");
  });

  it("resolves env SecretRefs at runtime", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          accounts: {
            service: {
              token: { source: "env", provider: "default", id: "CLICKCLACK_SERVICE_TOKEN" },
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(
      resolveClickClackAccount({
        cfg,
        accountId: "service",
        env: { CLICKCLACK_SERVICE_TOKEN: "  ccb_live  " },
      }),
    ).toEqual({
      allowFrom: ["*"],
      accountId: "service",
      baseUrl: "https://app.clickclack.chat",
      config: {
        allowFrom: ["*"],
        baseUrl: "https://app.clickclack.chat",
        enabled: true,
        token: { source: "env", provider: "default", id: "CLICKCLACK_SERVICE_TOKEN" },
        workspace: "wsp_1",
      },
      configured: true,
      defaultTo: "channel:general",
      enabled: true,
      reconnectMs: 1_500,
      replyMode: "agent",
      token: "ccb_live",
      workspace: "wsp_1",
    });
  });

  it("does not mark missing env SecretRefs as configured", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          accounts: {
            service: {
              token: { source: "env", provider: "default", id: "CLICKCLACK_SERVICE_TOKEN" },
            },
          },
        },
      },
    } satisfies CoreConfig;

    const account = resolveClickClackAccount({
      cfg,
      accountId: "service",
      env: {},
    });
    expect(account.configured).toBe(false);
    expect(account.token).toBe("");
  });

  it("resolves model-mode bot account policy", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          accounts: {
            peter: {
              token: "ccb_peter",
              agentId: "peter-bot",
              replyMode: "model",
              model: "openai/gpt-5.4-mini",
              toolsAllow: ["web_search"],
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveClickClackAccount({ cfg, accountId: "peter" })).toEqual({
      allowFrom: ["*"],
      accountId: "peter",
      agentId: "peter-bot",
      baseUrl: "https://app.clickclack.chat",
      config: {
        agentId: "peter-bot",
        allowFrom: ["*"],
        baseUrl: "https://app.clickclack.chat",
        enabled: true,
        model: "openai/gpt-5.4-mini",
        replyMode: "model",
        token: "ccb_peter",
        toolsAllow: ["web_search"],
        workspace: "wsp_1",
      },
      configured: true,
      defaultTo: "channel:general",
      enabled: true,
      model: "openai/gpt-5.4-mini",
      reconnectMs: 1_500,
      replyMode: "model",
      token: "ccb_peter",
      toolsAllow: ["web_search"],
      workspace: "wsp_1",
    });
  });

  it("normalizes reconnect intervals to the public config bounds", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          token: "ccb_global",
          workspace: "wsp_1",
          reconnectMs: 1,
          accounts: {
            slow: {
              reconnectMs: 1_000_000,
            },
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveClickClackAccount({ cfg }).reconnectMs).toBe(100);
    expect(resolveClickClackAccount({ cfg, accountId: "slow" }).reconnectMs).toBe(60_000);
  });

  it("marks exec SecretRefs as configured without resolving the value synchronously (#98428)", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          accounts: {
            service: {
              token: {
                source: "exec",
                provider: "example_exec",
                id: "CLICKCLACK_SERVICE_TOKEN",
              },
            },
          },
        },
      },
      secrets: {
        providers: {
          example_exec: {
            source: "exec",
            command: "/path/to/resolver",
            jsonOnly: true,
          },
        },
      },
    } satisfies CoreConfig;

    const account = resolveClickClackAccount({ cfg, accountId: "service" });
    // Sync inspect path: configured even though exec value can't be read here.
    expect(account.configured).toBe(true);
    // Sync inspect path leaves the value empty; runtime resolver materializes it.
    expect(account.token).toBe("");
  });

  it("marks file SecretRefs as configured without resolving the value synchronously (#98428)", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          token: {
            source: "file",
            provider: "mounted_secret",
            id: "/clickclack/token",
          },
        },
      },
      secrets: {
        providers: {
          mounted_secret: {
            source: "file",
            path: "/etc/openclaw/secrets.json",
          },
        },
      },
    } satisfies CoreConfig;

    expect(resolveClickClackAccount({ cfg }).configured).toBe(true);
    expect(resolveClickClackAccount({ cfg }).token).toBe("");
  });

  it("rejects SecretRefs whose provider source cannot resolve the requested source", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          token: {
            source: "file",
            provider: "example_exec",
            id: "/clickclack/token",
          },
        },
      },
      secrets: {
        providers: {
          example_exec: {
            source: "exec",
            command: "/path/to/resolver",
          },
        },
      },
    } satisfies CoreConfig;

    expect(() => resolveClickClackAccount({ cfg })).toThrow(
      'Secret provider "example_exec" has source "exec" but ref requests "file".',
    );
  });

  it("does not validate inactive SecretRefs for disabled accounts", () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          accounts: {
            stale: {
              enabled: false,
              token: {
                source: "exec",
                provider: "missing_exec",
                id: "clickclack/token",
              },
            },
          },
        },
      },
    } satisfies CoreConfig;

    const account = resolveClickClackAccount({ cfg, accountId: "stale" });
    expect(account.enabled).toBe(false);
    expect(account.configured).toBe(false);
    expect(account.token).toBe("");
  });

  it("resolveClickClackRuntimeToken resolves configured SecretRefs via the SDK runtime resolver", async () => {
    const cfg = {
      channels: {
        clickclack: {
          enabled: true,
          baseUrl: "https://app.clickclack.chat",
          workspace: "wsp_1",
          accounts: {
            service: {
              token: {
                source: "env",
                provider: "default",
                id: "CLICKCLACK_SERVICE_TOKEN",
              },
            },
          },
        },
      },
    } satisfies CoreConfig;

    const token = await resolveClickClackRuntimeToken({
      cfg,
      accountId: "service",
      value: cfg.channels.clickclack?.accounts?.service?.token,
      env: { CLICKCLACK_SERVICE_TOKEN: "ccb_runtime_live" },
    });
    expect(token).toBe("ccb_runtime_live");
  });
});
