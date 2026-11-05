import * as replyRuntime from "openclaw/plugin-sdk/reply-runtime";
import { mockPinnedHostnameResolution } from "openclaw/plugin-sdk/test-env";
import { afterEach, vi } from "vitest";
import { lineResult } from "./channel.sendPayload.test-support.js";
import * as markdown from "./markdown-to-line.js";
import * as media from "./outbound-media.js";
import * as send from "./send.js";
import * as templates from "./template-messages.js";

export type LineAutoReplyDeps = Pick<
  typeof send,
  "replyMessageLine" | "pushMessagesLine" | "createFlexMessage" | "createLocationMessage"
> & {
  buildTemplateMessageFromPayload: typeof templates.buildTemplateMessageFromPayload;
  processLineMessage: typeof markdown.processLineMessage;
  chunkMarkdownText: typeof replyRuntime.chunkMarkdownText;
  buildMediaMessage: typeof media.buildLineMediaMessage;
};

const moduleMocks: Array<{ mockRestore(): void }> = [];

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

export const createFlexMessage: LineAutoReplyDeps["createFlexMessage"] = (altText, contents) => ({
  type: "flex",
  altText,
  contents,
});

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

export function createDeps(overrides?: Partial<LineAutoReplyDeps>) {
  moduleMocks.push(mockPinnedHostnameResolution());
  const replyMessageLine = vi.fn<LineAutoReplyDeps["replyMessageLine"]>(async () => {});
  const buildMediaMessage = vi.fn(media.buildLineMediaMessage);
  const pushMessagesLine = vi.fn<LineAutoReplyDeps["pushMessagesLine"]>(async () =>
    lineResult("push", "u1"),
  );
  const deps: LineAutoReplyDeps = {
    buildTemplateMessageFromPayload: () => null,
    processLineMessage: (text) => (text ? [{ type: "text", text }] : []),
    chunkMarkdownText: (text) => [text],
    replyMessageLine,
    pushMessagesLine,
    createFlexMessage,
    buildMediaMessage,
    createLocationMessage: (location) => ({ type: "location", ...location }),
    ...overrides,
  };

  // Capture per-case implementations before installing spies so real-renderer
  // overrides retain the original function instead of calling their own spy.
  moduleMocks.push(
    vi
      .spyOn(templates, "buildTemplateMessageFromPayload")
      .mockImplementation(deps.buildTemplateMessageFromPayload),
    vi.spyOn(markdown, "processLineMessage").mockImplementation(deps.processLineMessage),
    vi.spyOn(replyRuntime, "chunkMarkdownText").mockImplementation(deps.chunkMarkdownText),
    vi.spyOn(send, "replyMessageLine").mockImplementation(deps.replyMessageLine),
    vi.spyOn(send, "pushMessagesLine").mockImplementation(deps.pushMessagesLine),
    vi.spyOn(send, "createFlexMessage").mockImplementation(deps.createFlexMessage),
    vi.spyOn(media, "buildLineMediaMessage").mockImplementation(deps.buildMediaMessage),
    vi.spyOn(send, "createLocationMessage").mockImplementation(deps.createLocationMessage),
  );

  return { replyMessageLine, buildMediaMessage, pushMessagesLine };
}
