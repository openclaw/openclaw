import type { OpenClawConfig } from "openclaw/plugin-sdk/feishu";
import { describe, expect, it, vi } from "vitest";

const probeFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./probe.js", () => ({
  probeFeishu: probeFeishuMock,
}));

import { feishuPlugin } from "./channel.js";

describe("feishuPlugin.mentions.stripPatterns", () => {
  it("strips <at user_id> tag leaving only the command", () => {
    // Regression test for #35994: group slash commands require the bot mention
    // <at> tag to be stripped before command detection so @Bot /model → /model.
    const patterns = feishuPlugin.mentions?.stripPatterns?.({ ctx: {} as any, cfg: {} as any });
    expect(patterns).toBeDefined();
    expect(patterns!.length).toBeGreaterThan(0);
    const re = new RegExp(patterns![0], "gi");
    expect('<at user_id="ou_bot">BotName</at> /model'.replace(re, " ").trim()).toBe("/model");
  });

  it("pattern does not strip unrelated text", () => {
    const patterns = feishuPlugin.mentions?.stripPatterns?.({ ctx: {} as any, cfg: {} as any });
    const re = new RegExp(patterns![0], "gi");
    expect("hello world".replace(re, " ").trim()).toBe("hello world");
  });
});

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
