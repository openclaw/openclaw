import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

import { feishuPlugin } from "./channel.js";

describe("feishuPlugin.status.probeAccount", () => {
  it("uses current account credentials for multi-account config", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            main: {
              appId: "cli_main",
              appSecret: "secret_main",
              enabled: true,
            },
          },
        },
      },
    } as OpenClawConfig;

    const account = feishuPlugin.config.resolveAccount(cfg, "main");
    probeFeishuMock.mockResolvedValueOnce({ ok: true, appId: "cli_main" });

    const result = await feishuPlugin.status?.probeAccount?.({
      account,
      timeoutMs: 1_000,
      cfg,
    });

    expect(probeFeishuMock).toHaveBeenCalledTimes(1);
    expect(probeFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "main",
        appId: "cli_main",
        appSecret: "secret_main",
      }),
    );
    expect(result).toMatchObject({ ok: true, appId: "cli_main" });
  });
});

describe("feishuPlugin.configSchema", () => {
  it("exposes top-level streamingInThread in channel schema", () => {
    const schema = feishuPlugin.configSchema?.schema as
      | {
          properties?: Record<string, unknown>;
        }
      | undefined;
    const streamingInThread = schema?.properties?.streamingInThread as
      | { enum?: string[] }
      | undefined;
    expect(streamingInThread?.enum).toEqual(["disabled", "enabled"]);
  });

  it("exposes account-level dispatchMode in channel schema", () => {
    const schema = feishuPlugin.configSchema?.schema as
      | {
          properties?: {
            accounts?: {
              additionalProperties?: {
                properties?: Record<string, unknown>;
              };
            };
          };
        }
      | undefined;

    const dispatchMode = schema?.properties?.accounts?.additionalProperties?.properties
      ?.dispatchMode as { enum?: string[] } | undefined;

    expect(dispatchMode?.enum).toEqual(["auto", "plugin"]);
  });

  it("exposes account-level streamingInThread in channel schema", () => {
    const schema = feishuPlugin.configSchema?.schema as
      | {
          properties?: {
            accounts?: {
              additionalProperties?: {
                properties?: Record<string, unknown>;
              };
            };
          };
        }
      | undefined;
    const streamingInThread = schema?.properties?.accounts?.additionalProperties?.properties
      ?.streamingInThread as { enum?: string[] } | undefined;
    expect(streamingInThread?.enum).toEqual(["disabled", "enabled"]);
  });

  it("exposes account-level pluginMode.forwardControlCommands in channel schema", () => {
    const schema = feishuPlugin.configSchema?.schema as
      | {
          properties?: {
            accounts?: {
              additionalProperties?: {
                properties?: Record<string, unknown>;
              };
            };
          };
        }
      | undefined;

    const pluginMode = schema?.properties?.accounts?.additionalProperties?.properties?.pluginMode as
      | {
          properties?: Record<string, unknown>;
        }
      | undefined;

    const forwardControlCommands = pluginMode?.properties?.forwardControlCommands as
      | { type?: string }
      | undefined;

    expect(forwardControlCommands?.type).toBe("boolean");
  });
});
