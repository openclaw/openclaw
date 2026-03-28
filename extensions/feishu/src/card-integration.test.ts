import { describe, expect, it, vi, beforeEach } from "vitest";
import { createRuntimeEnv } from "../../../test/helpers/extensions/runtime-env.js";
import type { ClawdbotConfig } from "../runtime-api.js";
import {
  handleFeishuCardAction,
  resetProcessedFeishuCardActionTokensForTests,
  type FeishuCardActionEvent,
} from "./card-action.js";
import { createFeishuCardInteractionEnvelope } from "./card-interaction.js";
import { getPendingCardUpdate, resetCardUpdateRegistryForTests } from "./card-update.js";

// Mock dependencies
vi.mock("./accounts.js", () => ({
  resolveFeishuAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
  resolveFeishuRuntimeAccount: vi.fn().mockReturnValue({ accountId: "mock-account" }),
}));

vi.mock("./bot.js", () => ({
  handleFeishuMessage: vi.fn(),
}));

const sendCardFeishuMock = vi.hoisted(() => vi.fn());
const updateCardFeishuMock = vi.hoisted(() => vi.fn());
vi.mock("./send.js", () => ({
  sendCardFeishu: sendCardFeishuMock,
  sendMessageFeishu: vi.fn(),
  updateCardFeishu: updateCardFeishuMock,
  buildMarkdownCard: vi.fn().mockReturnValue({ schema: "2.0" }),
}));

import { handleFeishuMessage } from "./bot.js";

describe("Feishu Card Update Integration", () => {
  const cfg: ClawdbotConfig = {};
  const runtime = createRuntimeEnv();

  beforeEach(() => {
    vi.clearAllMocks();
    resetProcessedFeishuCardActionTokensForTests();
    resetCardUpdateRegistryForTests();
  });

  it("full flow: card click -> processing state -> agent update", async () => {
    // Step 1: User clicks card button
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u123", user_id: "uid1", union_id: "un1" },
      token: "tok_integration",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "update",
          a: "feishu.card.update.generate",
          m: {
            messageId: "msg_original_456",
            prompt: "Generate a summary report",
            command: "/report",
          },
          c: { u: "u123", h: "chat1", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u123", user_id: "uid1", chat_id: "chat1" },
    };

    // Step 2: Handle card action
    await handleFeishuCardAction({ cfg, event, runtime });

    // Step 3: Verify original card updated to processing
    expect(updateCardFeishuMock).toHaveBeenCalledTimes(1);
    const processingCall = updateCardFeishuMock.mock.calls[0][0];
    expect(processingCall.messageId).toBe("msg_original_456");
    expect(processingCall.card.header.title.content).toBe("Processing...");

    // Step 4: Verify agent was dispatched
    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
    const dispatchCall = (handleFeishuMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const messageContent = JSON.parse(dispatchCall.event.message.content);

    // Extract updateId from dispatched message
    const updateIdMatch = messageContent.text.match(/updateId: (cu_\w+)/);
    expect(updateIdMatch).toBeTruthy();
    const updateId = updateIdMatch![1];

    // Step 5: Verify update is registered
    const pending = getPendingCardUpdate(updateId);
    expect(pending).toBeTruthy();
    expect(pending?.messageId).toBe("msg_original_456");
    expect(pending?.originalEnvelope.a).toBe("feishu.card.update.generate");
  });

  it("preserves chat type context through the update flow", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u456", user_id: "uid2", union_id: "un2" },
      token: "tok_p2p_flow",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "update",
          a: "feishu.card.update.translate",
          m: {
            messageId: "msg_p2p_789",
            prompt: "Translate to Spanish",
          },
          c: { u: "u456", h: "p2p_chat_xyz", t: "p2p", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u456", user_id: "uid2", chat_id: "p2p_chat_xyz" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    // Verify processing card updated in place
    expect(updateCardFeishuMock).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: "msg_p2p_789",
      }),
    );

    // Verify dispatch preserves p2p chat type
    expect(handleFeishuMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        event: expect.objectContaining({
          message: expect.objectContaining({
            chat_type: "p2p",
          }),
        }),
      }),
    );
  });

  it("registers pending update with correct account context", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u789", user_id: "uid3", union_id: "un3" },
      token: "tok_account_flow",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "update",
          a: "feishu.card.update.analyze",
          m: {
            messageId: "msg_account_test",
            command: "/analyze",
          },
          c: { u: "u789", h: "chat_account", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u789", user_id: "uid3", chat_id: "chat_account" },
    };

    await handleFeishuCardAction({ cfg, event, runtime, accountId: "custom-account" });

    // Extract updateId from dispatched message
    const dispatchCall = (handleFeishuMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const messageContent = JSON.parse(dispatchCall.event.message.content);
    const updateIdMatch = messageContent.text.match(/updateId: (cu_\w+)/);
    const updateId = updateIdMatch![1];

    // Verify pending update has correct account
    const pending = getPendingCardUpdate(updateId);
    expect(pending?.accountId).toBe("mock-account");
    expect(pending?.chatId).toBe("chat_account");
  });

  it("handles duplicate card action tokens in update flow", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u999", user_id: "uid4", union_id: "un4" },
      token: "tok_duplicate",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "update",
          a: "feishu.card.update.refresh",
          m: {
            messageId: "msg_duplicate_test",
            prompt: "Refresh data",
          },
          c: { u: "u999", h: "chat_dup", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u999", user_id: "uid4", chat_id: "chat_dup" },
    };

    // First call should succeed
    await handleFeishuCardAction({ cfg, event, runtime });

    // Second call with same token should be dropped
    await handleFeishuCardAction({ cfg, event, runtime });

    // Should only dispatch once
    expect(handleFeishuMessage).toHaveBeenCalledTimes(1);
    expect(updateCardFeishuMock).toHaveBeenCalledTimes(1);
  });

  it("rejects update action missing messageId", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u111", user_id: "uid5", union_id: "un5" },
      token: "tok_missing_msg",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "update",
          a: "feishu.card.update.test",
          m: {
            // messageId intentionally omitted
            prompt: "Test without message ID",
          },
          c: { u: "u111", h: "chat_missing", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u111", user_id: "uid5", chat_id: "chat_missing" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    // Should not dispatch to agent
    expect(handleFeishuMessage).not.toHaveBeenCalled();
    // Should send error notice
    expect(sendCardFeishuMock).not.toHaveBeenCalled();
  });

  it("includes prompt and command in processing card when available", async () => {
    const event: FeishuCardActionEvent = {
      operator: { open_id: "u222", user_id: "uid6", union_id: "un6" },
      token: "tok_with_metadata",
      action: {
        value: createFeishuCardInteractionEnvelope({
          k: "update",
          a: "feishu.card.update.execute",
          m: {
            messageId: "msg_with_meta",
            prompt: "Execute the analysis",
            command: "/analyze --deep",
          },
          c: { u: "u222", h: "chat_meta", t: "group", e: Date.now() + 60_000 },
        }),
        tag: "button",
      },
      context: { open_id: "u222", user_id: "uid6", chat_id: "chat_meta" },
    };

    await handleFeishuCardAction({ cfg, event, runtime });

    // Verify processing card includes the prompt
    const processingCall = updateCardFeishuMock.mock.calls[0][0];
    const elements = processingCall.card.body.elements;
    const hasPromptElement = elements.some(
      (el: { tag: string; content?: string }) =>
        el.tag === "markdown" && el.content?.includes("Execute the analysis"),
    );
    expect(hasPromptElement).toBe(true);

    // Verify dispatched message includes all metadata
    const dispatchCall = (handleFeishuMessage as ReturnType<typeof vi.fn>).mock.calls[0][0];
    const messageContent = JSON.parse(dispatchCall.event.message.content);
    expect(messageContent.text).toContain("prompt: Execute the analysis");
    expect(messageContent.text).toContain("command: /analyze --deep");
    expect(messageContent.text).toContain("action: feishu.card.update.execute");
  });
});
