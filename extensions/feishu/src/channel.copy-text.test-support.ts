import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../runtime-api.js";
import { feishuPlugin } from "./channel.js";

const sendCardFeishuMock = vi.hoisted(() => vi.fn());

vi.mock("./channel.runtime.js", () => ({
  feishuChannelRuntime: {
    feishuOutbound: {
      sendMedia: vi.fn(),
    },
    sendCardFeishu: sendCardFeishuMock,
  },
}));

const requireRecord = createRequireRecord("record", "expected-label-capitalized");

describe("Feishu direct copy-text presentation", () => {
  const cfg = {
    channels: {
      feishu: {
        enabled: true,
        appId: "cli_main",
        appSecret: "secret_main",
        dmPolicy: "open",
        allowFrom: ["*"],
        groupPolicy: "open",
      },
    },
  } as OpenClawConfig;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("preserves copy-text values as visible fallback in direct sends", async () => {
    sendCardFeishuMock.mockResolvedValueOnce({ messageId: "om_card", chatId: "oc_group_1" });

    await feishuPlugin.actions?.handleAction?.({
      action: "send",
      params: {
        to: "chat:oc_group_1",
        presentation: {
          blocks: [
            { type: "text", text: "Deployment ready" },
            {
              type: "buttons",
              buttons: [
                {
                  label: "Copy command",
                  action: { type: "copy-text", text: "openclaw status" },
                },
              ],
            },
          ],
        },
      },
      cfg,
      accountId: undefined,
      toolContext: {},
    } as never);

    const sendCardArgs = requireRecord(
      sendCardFeishuMock.mock.calls[0]?.[0],
      "send card arguments",
    );
    const card = requireRecord(sendCardArgs.card, "card");
    expect(requireRecord(card.body, "card body").elements).toEqual([
      { tag: "markdown", content: "Deployment ready" },
      {
        tag: "markdown",
        content: "<font color='grey'>Actions:\n- Copy command: `openclaw status`</font>",
      },
    ]);
  });
});
