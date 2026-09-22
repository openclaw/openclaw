// Shared fixtures for LINE auto-reply delivery tests.
import type { messagingApi } from "@line/bot-sdk";
import * as replyRuntime from "openclaw/plugin-sdk/reply-runtime";
import { afterEach, vi, type Mock, type MockInstance } from "vitest";
import { lineResult } from "./channel.sendPayload.test-support.js";
import * as markdown from "./markdown-to-line.js";
import * as media from "./outbound-media.js";
import * as send from "./send.js";
import * as templates from "./template-messages.js";

export type LineAutoReplyDeps = {
  buildTemplateMessageFromPayload: typeof templates.buildTemplateMessageFromPayload;
  processLineMessage: typeof markdown.processLineMessage;
  chunkMarkdownText: typeof replyRuntime.chunkMarkdownText;
  replyMessageLine: typeof send.replyMessageLine;
  pushMessagesLine: typeof send.pushMessagesLine;
  createFlexMessage: typeof send.createFlexMessage;
  buildMediaMessage: typeof media.buildLineMediaMessage;
  createLocationMessage: typeof send.createLocationMessage;
};

type LineAutoReplyTestDeps = {
  replyMessageLine: Mock<LineAutoReplyDeps["replyMessageLine"]>;
  buildMediaMessage: (
    ...args: Parameters<LineAutoReplyDeps["buildMediaMessage"]>
  ) => Promise<messagingApi.Message>;
  pushMessagesLine: Mock<LineAutoReplyDeps["pushMessagesLine"]>;
};

const moduleMocks: MockInstance[] = [];

afterEach(() => {
  for (const mock of moduleMocks.splice(0).toReversed()) {
    mock.mockRestore();
  }
});

export const LINE_TEST_CFG = { channels: { line: { accounts: { acc: {} } } } };

export const baseDeliveryParams = {
  cfg: LINE_TEST_CFG,
  to: "line:user:1",
  replyToken: "token",
  replyTokenUsed: false,
  accountId: "acc",
  textLimit: 5000,
};

export const createFlexMessage = (
  altText: string,
  contents: messagingApi.FlexContainer,
): messagingApi.FlexMessage => ({
  type: "flex",
  altText,
  contents,
});

/** LINE's wire shape for label-only quick replies, as the plugin builds them. */
export const createQuickReply = (...labels: string[]) => ({
  items: labels.map((label) => ({
    type: "action" as const,
    action: { type: "message" as const, label, text: label },
  })),
});

export const createImageMessage = (url: string) => ({
  type: "image" as const,
  originalContentUrl: url,
  previewImageUrl: url,
});

const createLocationMessage: LineAutoReplyDeps["createLocationMessage"] = (location) => ({
  type: "location" as const,
  ...location,
});

export function createDeps(overrides?: Partial<LineAutoReplyDeps>): LineAutoReplyTestDeps {
  const replyMessageLine = vi.fn<LineAutoReplyDeps["replyMessageLine"]>(async () => {});
  const buildMediaMessage: LineAutoReplyDeps["buildMediaMessage"] = vi.fn(
    async (mediaUrl, options) => {
      switch (options.mediaKind) {
        case "video":
          if (!options.previewImageUrl) {
            throw new Error(
              "LINE video messages require previewImageUrl to reference an image URL",
            );
          }
          return {
            type: "video" as const,
            originalContentUrl: mediaUrl,
            previewImageUrl: options.previewImageUrl,
          };
        case "audio":
          return {
            type: "audio" as const,
            originalContentUrl: mediaUrl,
            duration: options.durationMs ?? 60_000,
          };
        default:
          return createImageMessage(mediaUrl);
      }
    },
  );
  const pushMessagesLine = vi.fn<LineAutoReplyDeps["pushMessagesLine"]>(async () =>
    lineResult("push", "u1"),
  );
  const deps: LineAutoReplyDeps = {
    buildTemplateMessageFromPayload: () => null,
    processLineMessage: (text) => ({ text, flexMessages: [] }),
    chunkMarkdownText: (text) => [text],
    replyMessageLine,
    pushMessagesLine,
    createFlexMessage,
    buildMediaMessage,
    createLocationMessage,
    ...overrides,
  };

  // Capture per-case implementations before installing spies so real-renderer
  // overrides retain the original function instead of calling their own spy.
  moduleMocks.push(
    vi
      .spyOn(templates, "buildTemplateMessageFromPayload")
      .mockImplementation(deps.buildTemplateMessageFromPayload),
  );
  moduleMocks.push(
    vi.spyOn(markdown, "processLineMessage").mockImplementation(deps.processLineMessage),
  );
  moduleMocks.push(
    vi.spyOn(replyRuntime, "chunkMarkdownText").mockImplementation(deps.chunkMarkdownText),
  );
  moduleMocks.push(vi.spyOn(send, "replyMessageLine").mockImplementation(deps.replyMessageLine));
  moduleMocks.push(vi.spyOn(send, "pushMessagesLine").mockImplementation(deps.pushMessagesLine));
  moduleMocks.push(vi.spyOn(send, "createFlexMessage").mockImplementation(deps.createFlexMessage));
  moduleMocks.push(
    vi.spyOn(media, "buildLineMediaMessage").mockImplementation(deps.buildMediaMessage),
  );
  moduleMocks.push(
    vi.spyOn(send, "createLocationMessage").mockImplementation(deps.createLocationMessage),
  );

  return {
    replyMessageLine,
    buildMediaMessage,
    pushMessagesLine,
  };
}
