import { describe, expect, it, vi } from "vitest";
import { telegramApprovalNativeRuntime } from "./approval-handler.runtime.js";

type TelegramPayload = {
  text: string;
  buttons?: Array<Array<{ text: string; callback_data: string }>>;
};

describe("telegramApprovalNativeRuntime", () => {
  it("renders only the allowed pending buttons", async () => {
    const payload = (await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
      },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        commandText: "echo hi",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: "/approve req-1 allow-once",
            style: "success",
          },
          {
            decision: "deny",
            label: "Deny",
            command: "/approve req-1 deny",
            style: "danger",
          },
        ],
      } as never,
    })) as TelegramPayload;

    expect(payload.text).toContain("/approve req-1 allow-once");
    expect(payload.text).not.toContain("allow-always");
    expect(payload.buttons?.[0]?.map((button) => button.text)).toEqual(["Allow Once", "Deny"]);
  });

  it("falls back to request allowed decisions when the native exec view has no actions", async () => {
    const payload = (await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
      },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
          allowedDecisions: ["allow-once", "deny"],
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        commandText: "echo hi",
        actions: [],
      } as never,
    })) as TelegramPayload;

    expect(payload.text).toContain("/approve req-1 allow-once");
    expect(payload.text).not.toContain("allow-always");
    expect(payload.buttons?.[0]?.map((button) => button.text)).toEqual(["Allow Once", "Deny"]);
  });

  it("keeps exec approval callbacks compact enough for Telegram inline buttons", async () => {
    const approvalId = "a1bcdef0-long-approval-id-that-would-overflow-telegram-callback-data";
    const approvalSlug = approvalId.slice(0, 8);
    const payload = (await telegramApprovalNativeRuntime.presentation.buildPendingPayload({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
      },
      request: {
        id: approvalId,
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      nowMs: 0,
      view: {
        approvalKind: "exec",
        approvalId,
        commandText: "echo hi",
        actions: [
          {
            decision: "allow-once",
            label: "Allow Once",
            command: `/approve ${approvalId} allow-once`,
            style: "success",
          },
          {
            decision: "allow-always",
            label: "Allow Always",
            command: `/approve ${approvalId} allow-always`,
            style: "primary",
          },
          {
            decision: "deny",
            label: "Deny",
            command: `/approve ${approvalId} deny`,
            style: "danger",
          },
        ],
      } as never,
    })) as TelegramPayload;

    expect(payload.text).toContain(`/approve ${approvalSlug} allow-once`);
    expect(payload.buttons?.[0]?.map((button) => button.callback_data)).toEqual([
      `/approve ${approvalSlug} allow-once`,
      `/approve ${approvalSlug} always`,
      `/approve ${approvalSlug} deny`,
    ]);
    expect(
      payload.buttons?.[0]?.every(
        (button) => Buffer.byteLength(button.callback_data, "utf8") <= 64,
      ),
    ).toBe(true);
  });

  it("passes topic thread ids to typing and message delivery", async () => {
    const sendTyping = vi.fn().mockResolvedValue({ ok: true });
    const sendMessage = vi.fn().mockResolvedValue({
      chatId: "-1003841603622",
      messageId: "m1",
    });

    const entry = await telegramApprovalNativeRuntime.transport.deliverPending({
      cfg: {} as never,
      accountId: "default",
      context: {
        token: "tg-token",
        deps: {
          sendTyping,
          sendMessage,
        },
      },
      plannedTarget: {
        surface: "origin",
        reason: "preferred",
        target: {
          to: "-1003841603622",
          threadId: 928,
        },
      },
      preparedTarget: {
        chatId: "-1003841603622",
        messageThreadId: 928,
      },
      request: {
        id: "req-1",
        request: {
          command: "echo hi",
        },
        createdAtMs: 0,
        expiresAtMs: 60_000,
      },
      approvalKind: "exec",
      view: {
        approvalKind: "exec",
        approvalId: "req-1",
        commandText: "echo hi",
        actions: [],
      } as never,
      pendingPayload: {
        text: "pending",
        buttons: [],
      },
    });

    expect(sendTyping).toHaveBeenCalledWith(
      "-1003841603622",
      expect.objectContaining({
        token: "tg-token",
        accountId: "default",
        messageThreadId: 928,
      }),
    );
    expect(sendMessage).toHaveBeenCalledWith(
      "-1003841603622",
      "pending",
      expect.objectContaining({
        token: "tg-token",
        accountId: "default",
        messageThreadId: 928,
        buttons: [],
      }),
    );
    expect(entry).toEqual({
      chatId: "-1003841603622",
      messageId: "m1",
    });
  });
});
