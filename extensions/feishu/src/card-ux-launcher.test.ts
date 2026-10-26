// Feishu tests cover card ux launcher plugin behavior.
import { afterAll, afterEach, describe, expect, it, vi, beforeEach } from "vitest";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  expectFeishuCardButtonRow,
  expectFirstSentCardUsesFillWidthOnly,
} from "./card-test-helpers.js";
import { maybeHandleFeishuQuickActionMenu } from "./card-ux-launcher.js";

const sendCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
}));

describe("feishu quick-action launcher", () => {
  const cfg: ClawdbotConfig = {};

  afterAll(() => {
    vi.doUnmock("./send.js");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => vi.restoreAllMocks());

  it("opens the launcher from a supported bot menu event", async () => {
    sendCardFeishuMock.mockResolvedValue({ messageId: "m1", chatId: "c1" });
    vi.spyOn(Date, "now").mockReturnValue(100);

    const handled = await maybeHandleFeishuQuickActionMenu({
      cfg,
      eventKey: "quick-actions",
      operatorOpenId: "u123",
      accountId: "main",
    });

    expect(handled).toBe(true);
    expect(sendCardFeishuMock).toHaveBeenCalledTimes(1);
    const sendArgs = sendCardFeishuMock.mock.calls.at(0)?.[0] as
      | { accountId?: string; card?: unknown; cfg?: ClawdbotConfig; to?: string }
      | undefined;
    expect(Object.keys(sendArgs ?? {}).toSorted()).toEqual(["accountId", "card", "cfg", "to"]);
    expect(sendArgs?.cfg).toBe(cfg);
    expect(sendArgs?.to).toBe("user:u123");
    expect(sendArgs?.accountId).toBe("main");
    expectFirstSentCardUsesFillWidthOnly(sendCardFeishuMock);
    const buttons = expectFeishuCardButtonRow(sendArgs?.card);
    expect(buttons).toHaveLength(3);
    expect(buttons.map((button) => button.value)).toEqual([
      expect.objectContaining({ q: "/help", c: { u: "u123", e: 600_100, t: "p2p" } }),
      expect.objectContaining({ m: expect.objectContaining({ command: "/new" }) }),
      expect.objectContaining({ m: expect.objectContaining({ command: "/reset" }) }),
    ]);
  });
});
