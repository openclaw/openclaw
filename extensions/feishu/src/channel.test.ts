import type { OpenClawConfig } from "openclaw/plugin-sdk/feishu";
import { describe, expect, it, vi } from "vitest";

const probeFeishuMock = vi.hoisted(() => vi.fn());
const listReactionsFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

vi.mock("./reactions.js", () => ({
  addReactionFeishu: vi.fn(),
  listReactionsFeishu: listReactionsFeishuMock,
  removeReactionFeishu: vi.fn(),
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
  const cfg = {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_main",
        appSecret: "secret_main",
        actions: {
          reactions: true,
        },
      },
    },
  } as OpenClawConfig;

  it("does not advertise reactions when disabled via actions config", () => {
    const disabledCfg = {
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

    expect(feishuPlugin.actions?.listActions?.({ cfg: disabledCfg })).toEqual([]);
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

  it("requires clearAll=true before removing all bot reactions", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "react",
        params: { messageId: "om_msg1" },
        cfg,
        accountId: undefined,
      } as never),
    ).rejects.toThrow(
      "Emoji is required to add a Feishu reaction. Set clearAll=true to remove all bot reactions.",
    );
  });

  it("throws for unsupported Feishu send actions without card payload", async () => {
    await expect(
      feishuPlugin.actions?.handleAction?.({
        action: "send",
        params: { to: "chat:oc_group_1", message: "hello" },
        cfg,
        accountId: undefined,
      } as never),
    ).rejects.toThrow('Unsupported Feishu action: "send"');
  });

  it("allows explicit clearAll=true when removing all bot reactions", async () => {
    listReactionsFeishuMock.mockResolvedValueOnce([
      { reactionId: "r1", operatorType: "app" },
      { reactionId: "r2", operatorType: "app" },
    ]);

    const result = await feishuPlugin.actions?.handleAction?.({
      action: "react",
      params: { messageId: "om_msg1", clearAll: true },
      cfg,
      accountId: undefined,
    } as never);

    expect(listReactionsFeishuMock).toHaveBeenCalledWith({
      cfg,
      messageId: "om_msg1",
      accountId: undefined,
    });
    expect(result?.details).toMatchObject({ ok: true, removed: 2 });
  });
});
