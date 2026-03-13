import type { OpenClawConfig } from "openclaw/plugin-sdk/feishu";
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
  it("exposes threadBindings at the root and account levels", () => {
    const schema = feishuPlugin.configSchema?.schema as {
      properties?: Record<string, unknown>;
    };
    const rootThreadBindings = schema.properties?.threadBindings as
      | { properties?: Record<string, unknown> }
      | undefined;
    const accounts = schema.properties?.accounts as
      | {
          additionalProperties?: {
            properties?: Record<string, unknown>;
          };
        }
      | undefined;
    const accountThreadBindings = accounts?.additionalProperties?.properties?.threadBindings as
      | { properties?: Record<string, unknown> }
      | undefined;

    expect(rootThreadBindings?.properties?.spawnAcpSessions).toEqual({ type: "boolean" });
    expect(rootThreadBindings?.properties?.spawnSubagentSessions).toEqual({ type: "boolean" });
    expect(accountThreadBindings?.properties?.spawnAcpSessions).toEqual({ type: "boolean" });
    expect(accountThreadBindings?.properties?.spawnSubagentSessions).toEqual({
      type: "boolean",
    });
  });
});
