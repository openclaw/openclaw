import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import type { ClawdbotConfig, RuntimeEnv } from "../runtime-api.js";
import {
  createQuickActionLauncherCard,
  isFeishuQuickActionMenuEventKey,
  maybeHandleFeishuQuickActionMenu,
} from "./card-ux-launcher.js";

const sendCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
}));

describe("feishu quick-action launcher", () => {
  const cfg: ClawdbotConfig = {};

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recognizes the quick-actions bot menu key", () => {
    expect(isFeishuQuickActionMenuEventKey("quick-actions")).toBe(true);
    expect(isFeishuQuickActionMenuEventKey("other")).toBe(false);
  });

  it("builds a launcher card with interactive actions", () => {
    const card = createQuickActionLauncherCard({
      operatorOpenId: "u123",
      chatId: "chat1",
      expiresAt: 123,
      sessionKey: "agent:codex:feishu:chat:chat1",
    }) as {
      body: {
        elements: Array<{
          tag: string;
          actions?: Array<{ value?: { oc?: string; c?: { s?: string; t?: string } } }>;
        }>;
      };
    };

    const actionBlock = card.body.elements.find((entry) => entry.tag === "action");
    expect(actionBlock?.actions).toHaveLength(3);
    expect(actionBlock?.actions?.[0]?.value?.oc).toBe("ocf1");
    expect(actionBlock?.actions?.[0]?.value?.c?.s).toBe("agent:codex:feishu:chat:chat1");
    expect(actionBlock?.actions?.[0]?.value?.c?.t).toBeUndefined();
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
    expect(sendCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: "user:u123",
        accountId: "main",
        card: expect.objectContaining({
          body: expect.objectContaining({
            elements: expect.arrayContaining([
              expect.objectContaining({
                tag: "action",
                actions: expect.arrayContaining([
                  expect.objectContaining({
                    value: expect.objectContaining({
                      c: expect.objectContaining({
                        t: "p2p",
                      }),
                    }),
                  }),
                ]),
              }),
            ]),
          }),
        }),
      }),
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
