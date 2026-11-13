import { createChannelApprovalHandlerFromCapability } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { SystemAgentApprovalRequest } from "openclaw/plugin-sdk/approval-runtime";
import { beforeEach, expect, it, vi } from "vitest";
import { telegramApprovalCapability } from "./approval-native.js";

const { editMessage, sendMessage, sendTyping } = vi.hoisted(() => ({
  editMessage: vi.fn(),
  sendMessage: vi.fn(),
  sendTyping: vi.fn(),
}));
vi.mock("./send.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./send.js")>()),
  editMessageTelegram: editMessage,
  sendMessageTelegram: sendMessage,
  sendTypingTelegram: sendTyping,
  editMessageReplyMarkupTelegram: vi.fn(),
}));
beforeEach(() => {
  vi.resetAllMocks();
});

const base = { cfg: {}, accountId: "default", context: { token: "tg-token" } };
function systemRequest(
  id: string,
  request: Partial<SystemAgentApprovalRequest["request"]> = {},
  expiresAtMs = 60_000,
): SystemAgentApprovalRequest {
  return {
    approvalKind: "system-agent",
    id,
    createdAtMs: 0,
    expiresAtMs,
    request: {
      title: "OpenClaw change",
      description: "restart the Gateway",
      command: "restart the Gateway",
      proposalHash: "a".repeat(64),
      allowedDecisions: ["allow-once", "deny"],
      sessionId: "delegation-fixture",
      ...request,
    },
  };
}

it.each([
  [
    "allowed",
    "allow-once",
    undefined,
    undefined,
    "✅ OpenClaw change approved. Applying: restart the Gateway",
  ],
  [
    "applied",
    "allow-once",
    "applied",
    undefined,
    "✅ OpenClaw change approved and applied: restart the Gateway",
  ],
  [
    "not applied",
    "allow-once",
    "not-applied",
    undefined,
    "⚠️ OpenClaw change approved, but completion could not be confirmed. Check the current settings before retrying.",
  ],
  ["denied", "deny", undefined, undefined, "❌ OpenClaw change denied. No change was made."],
  [
    "cancelled",
    "deny",
    undefined,
    "cancelled",
    "⚠️ OpenClaw change was cancelled because its run ended. No change was made. Retry.",
  ],
  ["expired", null, undefined, undefined, "⏱️ OpenClaw change expired. No change was made."],
] as const)(
  "keeps the %s terminal result on the originating private topic",
  async (name, decision, applicationStatus, terminalStatus, text) => {
    sendTyping.mockResolvedValue(undefined);
    sendMessage.mockResolvedValue({ chatId: "1234", messageId: "m1" });
    editMessage.mockResolvedValue({ ok: true });
    const handler = await createChannelApprovalHandlerFromCapability({
      ...base,
      capability: telegramApprovalCapability,
      label: "telegram/approvals",
      clientDisplayName: "Telegram approvals",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {
        channels: {
          telegram: {
            botToken: "tg-token",
            execApprovals: { enabled: true, approvers: ["1234"], target: "dm" },
          },
        },
      },
      nowMs: () => 0,
    });
    if (!handler) {
      throw new Error("Expected a Telegram approval handler");
    }
    const request = systemRequest(`system-agent:terminal-${name}`, {
      turnSourceChannel: "telegram",
      turnSourceTo: "1234",
      turnSourceAccountId: "default",
      turnSourceThreadId: 42,
    });
    try {
      await handler.handleRequested(request);
      expect(sendMessage).toHaveBeenCalledOnce();
      expect(sendMessage).toHaveBeenCalledWith(
        "1234",
        expect.any(String),
        expect.objectContaining({ messageThreadId: 42 }),
      );
      sendMessage.mockClear();
      if (decision === null) {
        await handler.handleExpired(request.id);
      } else {
        await handler.handleResolved({
          id: request.id,
          decision,
          applicationStatus,
          terminalStatus,
          ts: 1,
        });
      }
      expect(editMessage).toHaveBeenCalledExactlyOnceWith(
        "1234",
        "m1",
        text,
        expect.objectContaining({ buttons: [] }),
      );
      expect(sendMessage).not.toHaveBeenCalled();
    } finally {
      await handler.stop();
    }
  },
);

it.each([
  ["requester first", ["1234", "5678"], false, "resolved"],
  ["requester second", ["5678", "1234"], false, "resolved"],
  ["requester second on expiry", ["5678", "1234"], false, "expired"],
  ["requester first edit fails", ["1234", "5678"], true, "resolved"],
  ["requester second edit fails", ["5678", "1234"], true, "resolved"],
  ["requester second edit fails on expiry", ["5678", "1234"], true, "expired"],
] as const)(
  "finalizes all approver cards without duplicate topic results: %s",
  async (_name, approvers, originEditFails, phase) => {
    sendTyping.mockResolvedValue(undefined);
    sendMessage.mockImplementation(async (chatId: string) => ({
      chatId,
      messageId: `message-${chatId}`,
    }));
    editMessage.mockImplementation(async (chatId: string) => {
      if (originEditFails && chatId === "1234") {
        throw new Error("message was deleted");
      }
      return { ok: true };
    });
    const handler = await createChannelApprovalHandlerFromCapability({
      ...base,
      capability: telegramApprovalCapability,
      label: "telegram/approvals",
      clientDisplayName: "Telegram approvals",
      channel: "telegram",
      channelLabel: "Telegram",
      cfg: {
        channels: {
          telegram: {
            botToken: "tg-token",
            execApprovals: { enabled: true, approvers: [...approvers], target: "dm" },
          },
        },
      },
      nowMs: () => 0,
    });
    if (!handler) {
      throw new Error("Expected a Telegram approval handler");
    }
    const request = systemRequest(`system-agent:fanout-${_name}`, {
      turnSourceChannel: "telegram",
      turnSourceTo: "1234",
      turnSourceAccountId: "default",
      turnSourceThreadId: 42,
    });
    try {
      await handler.handleRequested(request);
      expect(sendMessage).toHaveBeenCalledTimes(2);
      expect(sendMessage).toHaveBeenCalledWith(
        "1234",
        expect.any(String),
        expect.objectContaining({ messageThreadId: 42 }),
      );
      expect(sendMessage).toHaveBeenCalledWith(
        "5678",
        expect.any(String),
        expect.not.objectContaining({ messageThreadId: 42 }),
      );
      sendMessage.mockClear();
      if (phase === "expired") {
        await handler.handleExpired(request.id);
      } else {
        await handler.handleResolved({ id: request.id, decision: "deny", ts: 1 });
      }
      expect(editMessage.mock.calls.map(([chatId]) => chatId)).toEqual([...approvers]);
      expect(editMessage).toHaveBeenCalledWith(
        "1234",
        "message-1234",
        expect.any(String),
        expect.objectContaining({ buttons: [] }),
      );
      expect(editMessage).toHaveBeenCalledWith(
        "5678",
        "message-5678",
        expect.any(String),
        expect.objectContaining({ buttons: [] }),
      );
      expect(sendMessage).toHaveBeenCalledTimes(originEditFails ? 1 : 0);
      if (originEditFails) {
        expect(sendMessage).toHaveBeenCalledWith(
          "1234",
          expect.any(String),
          expect.objectContaining({ messageThreadId: 42 }),
        );
      }
    } finally {
      await handler.stop();
    }
  },
);
