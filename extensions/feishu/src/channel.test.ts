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

describe("feishuPlugin actions", () => {
  it("does not advertise reactions when disabled via actions config", () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          appId: "cli_main",
          appSecret: "secret_main",
          actions: {
            reactions: false,
          },
        },
      },
    } as OpenClawConfig;

    expect(feishuPlugin.actions?.listActions?.({ cfg })).toEqual([]);
  });

  it("advertises reactions when any enabled configured account allows them", () => {
    const cfg = {
      channels: {
        feishu: {
          enabled: true,
          defaultAccount: "main",
          actions: {
            reactions: false,
          },
          accounts: {
            main: {
              appId: "cli_main",
              appSecret: "secret_main",
              enabled: true,
              actions: {
                reactions: false,
              },
            },
            secondary: {
              appId: "cli_secondary",
              appSecret: "secret_secondary",
              enabled: true,
              actions: {
                reactions: true,
              },
            },
          },
        },
      },
    } as OpenClawConfig;

    expect(feishuPlugin.actions?.listActions?.({ cfg })).toEqual(["react", "reactions"]);
  });
});
