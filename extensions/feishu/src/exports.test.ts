import { describe, expect, it } from "vitest";

describe("feishu extension exports", () => {
  it("exports createFeishuReplyDispatcher and getBotOpenId", async () => {
    const mod = await import("../index.js");

    expect(typeof mod.createFeishuReplyDispatcher).toBe("function");
    expect(typeof mod.getBotOpenId).toBe("function");
  });
});
