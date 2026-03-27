import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../../src/config/config.js";
import { TelegramExecApprovalHandler } from "./exec-approvals-handler.js";

const baseRequest = {
  id: "9f1c7d5d-b1fb-46ef-ac45-662723b65bb7",
  request: {
    command: "npm view diver name version description",
    agentId: "main",
    sessionKey: "agent:main:telegram:group:-1003841603622:topic:928",
    turnSourceChannel: "telegram",
    turnSourceTo: "-1003841603622",
    turnSourceThreadId: "928",
    turnSourceAccountId: "default",
  },
  createdAtMs: 1000,
  expiresAtMs: 61_000,
};

function createHandler(cfg: OpenClawConfig) {
  const sendTyping = vi.fn().mockResolvedValue({ ok: true });
  const sendMessage = vi
    .fn()
    .mockResolvedValueOnce({ messageId: "m1", chatId: "-1003841603622" })
    .mockResolvedValue({ messageId: "m2", chatId: "8460800771" });
  const editReplyMarkup = vi.fn().mockResolvedValue({ ok: true });
  const handler = new TelegramExecApprovalHandler(
    {
      token: "tg-token",
      accountId: "default",
      cfg,
    },
    {
      nowMs: () => 1000,
      sendTyping,
      sendMessage,
      editReplyMarkup,
    },
  );
  return { handler, sendTyping, sendMessage, editReplyMarkup };
}

describe("TelegramExecApprovalHandler", () => {
  it("sends approval prompts to the originating telegram topic when target=channel", async () => {
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["8460800771"],
            target: "channel",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendTyping, sendMessage } = createHandler(cfg);

    await handler.handleRequested(baseRequest);

    expect(sendTyping).toHaveBeenCalledWith(
      "-1003841603622",
      expect.objectContaining({
        accountId: "default",
        messageThreadId: 928,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "-1003841603622",
      expect.stringContaining("/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once"),
      expect.objectContaining({
        accountId: "default",
        messageThreadId: 928,
        buttons: [
          [
            {
              text: "Allow Once",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 allow-once",
            },
            {
              text: "Allow Always",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 always",
            },
          ],
          [
            {
              text: "Deny",
              callback_data: "/approve 9f1c7d5d-b1fb-46ef-ac45-662723b65bb7 deny",
            },
          ],
        ],
      }),
    );
  });

  it("falls back to approver DMs when channel routing is unavailable", async () => {
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["111", "222"],
            target: "channel",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, sendMessage } = createHandler(cfg);

    await handler.handleRequested({
      ...baseRequest,
      request: {
        ...baseRequest.request,
        turnSourceChannel: "slack",
        turnSourceTo: "U1",
        turnSourceAccountId: null,
        turnSourceThreadId: null,
      },
    });

    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(sendMessage.mock.calls.map((call) => call[0])).toEqual(["111", "222"]);
  });

  it("clears buttons from tracked approval messages when resolved", async () => {
    const cfg = {
      channels: {
        telegram: {
          execApprovals: {
            enabled: true,
            approvers: ["8460800771"],
            target: "both",
          },
        },
      },
    } as OpenClawConfig;
    const { handler, editReplyMarkup } = createHandler(cfg);

    await handler.handleRequested(baseRequest);
    await handler.handleResolved({
      id: baseRequest.id,
      decision: "allow-once",
      resolvedBy: "telegram:8460800771",
      ts: 2000,
    });

    expect(editReplyMarkup).toHaveBeenCalled();
    expect(editReplyMarkup).toHaveBeenCalledWith(
      "-1003841603622",
      "m1",
      [],
      expect.objectContaining({
        accountId: "default",
      }),
    );
  });
});
