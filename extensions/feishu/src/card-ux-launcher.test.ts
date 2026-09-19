// Feishu tests cover card ux launcher plugin behavior.
import { createRuntimeEnv } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterAll, describe, expect, it, vi, beforeEach } from "vitest";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import { decodeFeishuCardAction } from "./card-interaction.js";
import {
  expectFeishuCardButtonRow,
  expectFirstSentCardUsesFillWidthOnly,
  expectSentCardHasP2pAction,
} from "./card-test-helpers.js";
import { FEISHU_APPROVAL_REQUEST_ACTION } from "./card-ux-approval.js";
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

  it("ignores unsupported bot menu keys", async () => {
    await expect(
      maybeHandleFeishuQuickActionMenu({
        cfg,
        eventKey: "other",
        operatorOpenId: "u123",
      }),
    ).resolves.toBe(false);
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it("opens the launcher from a supported bot menu event", async () => {
    sendCardFeishuMock.mockResolvedValue({ messageId: "m1", chatId: "c1" });

    const handled = await maybeHandleFeishuQuickActionMenu({
      cfg,
      eventKey: "quick-actions",
      operatorOpenId: "u123",
      accountId: "main",
      now: 100,
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
    const buttons = expectFeishuCardButtonRow(sendArgs?.card);
    expect(buttons.map((button) => button.text)).toEqual([
      { tag: "plain_text", content: "Help" },
      { tag: "plain_text", content: "New session" },
      { tag: "plain_text", content: "Reset" },
    ]);
    expect(buttons.map((button) => button.type)).toEqual(["default", "primary", "danger"]);
    const context = { u: "u123", t: "p2p", e: 600_100 };
    expect(buttons.map((button) => button.value)).toEqual([
      { oc: "ocf1", k: "quick", a: "feishu.quick_actions.help", q: "/help", c: context },
      {
        oc: "ocf1",
        k: "meta",
        a: FEISHU_APPROVAL_REQUEST_ACTION,
        m: {
          command: "/new",
          prompt: "Start a fresh session? This will reset the current chat context.",
        },
        c: context,
      },
      {
        oc: "ocf1",
        k: "meta",
        a: FEISHU_APPROVAL_REQUEST_ACTION,
        m: {
          command: "/reset",
          prompt: "Reset this session now? Any active conversation state will be cleared.",
        },
        c: context,
      },
    ]);
    for (const button of buttons) {
      expect(
        decodeFeishuCardAction({
          event: { operator: { open_id: "u123" }, context: {}, action: { value: button.value } },
          now: 100,
        }),
      ).toEqual({ kind: "structured", envelope: button.value });
    }
    expectSentCardHasP2pAction(sendCardFeishuMock);
    expectFirstSentCardUsesFillWidthOnly(sendCardFeishuMock);
  });

  it("does not send launcher cards when expiry would exceed a valid Date", async () => {
    const runtime: RuntimeEnv = createRuntimeEnv();

    const handled = await maybeHandleFeishuQuickActionMenu({
      cfg,
      eventKey: "quick-actions",
      operatorOpenId: "u123",
      accountId: "main",
      runtime,
      now: 8_640_000_000_000_000,
    });

    expect(handled).toBe(false);
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
    expect(runtime.log).toHaveBeenCalledWith(
      "feishu[main]: failed to open quick-action launcher for u123: invalid expiry clock",
    );
  });

  it("falls back to legacy menu handling when launcher send fails", async () => {
    sendCardFeishuMock.mockRejectedValueOnce(new Error("network"));
    const runtime: RuntimeEnv = createRuntimeEnv();

    const handled = await maybeHandleFeishuQuickActionMenu({
      cfg,
      eventKey: "quick-actions",
      operatorOpenId: "u123",
      accountId: "main",
      runtime,
      now: 100,
    });

    expect(handled).toBe(false);
  });
});
