import { afterEach, type MockInstance, vi } from "vitest";
import type { PluginRuntime } from "../api.js";
import { createLineSendReceipt } from "./send-receipt.js";
import * as send from "./send.js";
import * as templates from "./template-messages.js";

const moduleMocks: MockInstance[] = [];

afterEach(() => {
  for (const mock of moduleMocks.splice(0).toReversed()) {
    mock.mockRestore();
  }
});

export function lineResult(messageId: string, chatId = "c1") {
  return {
    messageId,
    chatId,
    receipt: createLineSendReceipt({ messageId, chatId, kind: "text" }),
  };
}

export function createRuntime() {
  const pushMessageLine = vi
    .spyOn(send, "pushMessageLine")
    .mockImplementation(async () => lineResult("m-text"));
  const pushMessagesLine = vi
    .spyOn(send, "pushMessagesLine")
    .mockImplementation(async () => lineResult("m-batch"));
  const pushFlexMessage = vi
    .spyOn(send, "pushFlexMessage")
    .mockImplementation(async () => lineResult("m-flex"));
  const pushTemplateMessage = vi
    .spyOn(send, "pushTemplateMessage")
    .mockImplementation(async () => lineResult("m-template"));
  const pushLocationMessage = vi
    .spyOn(send, "pushLocationMessage")
    .mockImplementation(async () => lineResult("m-loc"));
  const pushTextMessageWithQuickReplies = vi
    .spyOn(send, "pushTextMessageWithQuickReplies")
    .mockImplementation(async () => lineResult("m-quick"));
  const createQuickReplyItems = vi.spyOn(send, "createQuickReplyItems");
  const buildTemplateMessageFromPayload = vi
    .spyOn(templates, "buildTemplateMessageFromPayload")
    .mockImplementation(() => ({
      type: "template",
      altText: "Continue?",
      template: {
        type: "confirm",
        text: "Continue?",
        actions: [
          { type: "message", label: "Yes", text: "yes" },
          { type: "message", label: "No", text: "no" },
        ],
      },
    }));
  const sendMessageLine = vi
    .spyOn(send, "sendMessageLine")
    .mockImplementation(async () => lineResult("m-media"));
  moduleMocks.push(
    pushMessageLine,
    pushMessagesLine,
    pushFlexMessage,
    pushTemplateMessage,
    pushLocationMessage,
    pushTextMessageWithQuickReplies,
    createQuickReplyItems,
    buildTemplateMessageFromPayload,
    sendMessageLine,
  );
  const chunkMarkdownText = vi.fn<PluginRuntime["channel"]["text"]["chunkMarkdownText"]>((text) => [
    text,
  ]);
  const resolveTextChunkLimit = vi.fn<PluginRuntime["channel"]["text"]["resolveTextChunkLimit"]>(
    () => 123,
  );

  const runtime = {
    channel: {
      text: {
        chunkMarkdownText,
        resolveTextChunkLimit,
      },
    },
  } as unknown as PluginRuntime;

  return {
    runtime,
    mocks: {
      pushMessageLine,
      pushMessagesLine,
      pushFlexMessage,
      pushTemplateMessage,
      pushLocationMessage,
      pushTextMessageWithQuickReplies,
      createQuickReplyItems,
      buildTemplateMessageFromPayload,
      sendMessageLine,
      chunkMarkdownText,
      resolveTextChunkLimit,
    },
  };
}
