import { describe, expect, it, vi } from "vitest";

describe("feishu extension exports", () => {
  it("exports createFeishuReplyDispatcher and getBotOpenId", async () => {
    const mod = await import("../index.js");

    expect(typeof mod.createFeishuReplyDispatcher).toBe("function");
    expect(typeof mod.getBotOpenId).toBe("function");
  });

  it("register() exposes native feishu dispatcher on runtime.channel.reply", async () => {
    const mod = await import("../index.js");
    const register = mod.default.register as (api: unknown) => void;
    const runtime = {
      channel: {
        reply: {},
      },
    };
    register({
      config: {},
      logger: {},
      runtime,
      registerChannel: vi.fn(),
      registerTool: vi.fn(),
    });
    expect(
      typeof (runtime as { channel: { reply: { createFeishuReplyDispatcher?: unknown } } }).channel
        .reply.createFeishuReplyDispatcher,
    ).toBe("function");
  });
});
