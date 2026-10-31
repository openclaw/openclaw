import { createMessageReceiptFromOutboundResults } from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, type MockInstance, vi } from "vitest";
import type { PluginRuntime } from "../api.js";
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
    receipt: createMessageReceiptFromOutboundResults({
      results: [
        { channel: "line", messageId, chatId, conversationId: chatId, meta: { messageCount: 1 } },
      ],
      threadId: chatId,
      kind: "text",
    }),
  };
}

export function createRuntime() {
  const mocks = {
    pushMessageLine: vi
      .spyOn(send, "pushMessageLine")
      .mockImplementation(async (_to, _text, opts) =>
        lineResult(opts.mediaUrl ? "m-media" : "m-text"),
      ),
    pushMessagesLine: vi
      .spyOn(send, "pushMessagesLine")
      .mockImplementation(async () => lineResult("m-batch")),
    pushFlexMessage: vi
      .spyOn(send, "pushFlexMessage")
      .mockImplementation(async () => lineResult("m-flex")),
    pushTemplateMessage: vi
      .spyOn(send, "pushTemplateMessage")
      .mockImplementation(async () => lineResult("m-template")),
    pushLocationMessage: vi
      .spyOn(send, "pushLocationMessage")
      .mockImplementation(async () => lineResult("m-loc")),
    pushTextMessageWithQuickReplies: vi
      .spyOn(send, "pushTextMessageWithQuickReplies")
      .mockImplementation(async () => lineResult("m-quick")),
    createQuickReplyItems: vi.spyOn(send, "createQuickReplyItems"),
    buildTemplateMessageFromPayload: vi
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
      })),
  };
  moduleMocks.push(...Object.values(mocks));
  const text = {
    chunkMarkdownText: vi.fn<PluginRuntime["channel"]["text"]["chunkMarkdownText"]>((value) => [
      value,
    ]),
    resolveTextChunkLimit: vi.fn<PluginRuntime["channel"]["text"]["resolveTextChunkLimit"]>(
      () => 123,
    ),
  };
  return {
    runtime: { channel: { text } } as unknown as PluginRuntime,
    mocks: { ...mocks, ...text },
  };
}
