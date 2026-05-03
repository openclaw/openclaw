import { describe, expect, it } from "vitest";
import {
  bindTelegramApprovalReply,
  clearTelegramApprovalReplyBindingsForTest,
  parseTelegramApprovalReplyDecision,
  resolveTelegramApprovalReplyBinding,
  unbindTelegramApprovalReply,
} from "./approval-reply-bindings.js";

describe("telegram approval reply bindings", () => {
  it("parses only explicit approval decisions", () => {
    expect(parseTelegramApprovalReplyDecision("approved")).toBe("allow-once");
    expect(parseTelegramApprovalReplyDecision("allow once")).toBe("allow-once");
    expect(parseTelegramApprovalReplyDecision("allow-always")).toBe("allow-always");
    expect(parseTelegramApprovalReplyDecision("deny")).toBe("deny");
    expect(parseTelegramApprovalReplyDecision("yes")).toBeNull();
    expect(parseTelegramApprovalReplyDecision("approved for everything")).toBeNull();
  });

  it("resolves a fresh binding for the exact replied-to approval message", () => {
    clearTelegramApprovalReplyBindingsForTest();
    const binding = bindTelegramApprovalReply({
      accountId: "default",
      chatId: "1234",
      messageId: "77",
      approvalId: "approval-1",
      approvalKind: "exec",
      createdAtMs: 1_000,
      expiresAtMs: 61_000,
      allowedDecisions: ["allow-once", "deny"],
      commandText: "printf ok",
    });

    expect(
      resolveTelegramApprovalReplyBinding({
        accountId: "default",
        chatId: "1234",
        replyToMessageId: "77",
        nowMs: 2_000,
      }),
    ).toEqual({ ok: true, binding });
  });

  it("rejects and clears stale bindings", () => {
    clearTelegramApprovalReplyBindingsForTest();
    bindTelegramApprovalReply({
      accountId: "default",
      chatId: "1234",
      messageId: "77",
      approvalId: "approval-1",
      approvalKind: "exec",
      createdAtMs: 1_000,
      expiresAtMs: 2_000,
      allowedDecisions: ["allow-once"],
    });

    expect(
      resolveTelegramApprovalReplyBinding({
        accountId: "default",
        chatId: "1234",
        replyToMessageId: "77",
        nowMs: 3_000,
      }),
    ).toEqual({ ok: false, reason: "stale" });
    expect(
      resolveTelegramApprovalReplyBinding({
        accountId: "default",
        chatId: "1234",
        replyToMessageId: "77",
        nowMs: 3_001,
      }),
    ).toEqual({ ok: false, reason: "missing" });
  });

  it("unbinds after resolution so allow-once cannot be reused", () => {
    clearTelegramApprovalReplyBindingsForTest();
    const binding = bindTelegramApprovalReply({
      accountId: "default",
      chatId: "1234",
      messageId: "77",
      approvalId: "approval-1",
      approvalKind: "exec",
      createdAtMs: 1_000,
      expiresAtMs: 61_000,
      allowedDecisions: ["allow-once"],
    });

    unbindTelegramApprovalReply(binding);

    expect(
      resolveTelegramApprovalReplyBinding({
        accountId: "default",
        chatId: "1234",
        replyToMessageId: "77",
        nowMs: 2_000,
      }),
    ).toEqual({ ok: false, reason: "missing" });
  });
});
