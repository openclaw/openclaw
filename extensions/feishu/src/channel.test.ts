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

describe("feishuPlugin.status.buildAccountSnapshot", () => {
  it("preserves websocket lifecycle runtime fields for health monitoring", async () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          accounts: {
            main: {
              appId: "cli_main",
              appSecret: "secret_main",
              enabled: true,
              connectionMode: "websocket",
            },
          },
        },
      },
    } as OpenClawConfig;

    const account = feishuPlugin.config.resolveAccount(cfg, "main");
    const snapshot = await feishuPlugin.status?.buildAccountSnapshot?.({
      account,
      cfg,
      runtime: {
        accountId: "main",
        running: true,
        connected: false,
        reconnectAttempts: 4,
        lastConnectedAt: 123,
        lastDisconnect: { at: 456, error: "socket dropped" },
        lastEventAt: 789,
        mode: "websocket",
        port: 3000,
      },
    });

    expect(snapshot).toMatchObject({
      accountId: "main",
      connected: false,
      reconnectAttempts: 4,
      lastConnectedAt: 123,
      lastDisconnect: { at: 456, error: "socket dropped" },
      lastEventAt: 789,
      mode: "websocket",
      port: 3000,
    });
  });
});
