import { describe, expect, it } from "vitest";
import { shouldSuppressNativeApprovalFallbackMessageSend } from "./native-approval-message-suppression.js";

describe("shouldSuppressNativeApprovalFallbackMessageSend", () => {
  it("suppresses implicit sends after deterministic approval delivery", () => {
    expect(
      shouldSuppressNativeApprovalFallbackMessageSend({
        action: "send",
        deterministicApprovalPromptSent: true,
        messageParams: { message: "Waiting for approval." },
      }),
    ).toBe(true);
  });

  it("keeps approval fallback text before deterministic approval delivery is confirmed", () => {
    expect(
      shouldSuppressNativeApprovalFallbackMessageSend({
        action: "send",
        currentChannelProvider: "googlechat",
        deterministicApprovalPromptSent: false,
        messageParams: {
          message: "Approval needed.\n\nPlease reply with:\n`/approve abc123 allow-once`",
          replyTo: "spaces/example/messages/1",
        },
      }),
    ).toBe(false);
  });

  it("keeps explicit alternate-route sends", () => {
    expect(
      shouldSuppressNativeApprovalFallbackMessageSend({
        action: "send",
        currentChannelProvider: "googlechat",
        deterministicApprovalPromptSent: true,
        messageParams: {
          message: "Approval needed.\n/approve abc123 allow-once",
          target: "telegram:123",
        },
      }),
    ).toBe(false);
  });

  it("suppresses same-channel selector sends after deterministic approval delivery", () => {
    expect(
      shouldSuppressNativeApprovalFallbackMessageSend({
        action: "send",
        currentChannelProvider: "googlechat",
        deterministicApprovalPromptSent: true,
        messageParams: {
          channel: "googlechat",
          message: "Approval needed.\n/approve abc123 allow-once",
        },
      }),
    ).toBe(true);
  });

  it("keeps different-channel selector sends", () => {
    expect(
      shouldSuppressNativeApprovalFallbackMessageSend({
        action: "send",
        currentChannelProvider: "googlechat",
        deterministicApprovalPromptSent: true,
        messageParams: {
          channel: "telegram",
          message: "Approval needed.\n/approve abc123 allow-once",
        },
      }),
    ).toBe(false);
  });

  it("keeps non-approval text on native channels before deterministic delivery", () => {
    expect(
      shouldSuppressNativeApprovalFallbackMessageSend({
        action: "send",
        currentChannelProvider: "googlechat",
        deterministicApprovalPromptSent: false,
        messageParams: { message: "I am checking that now." },
      }),
    ).toBe(false);
  });
});
