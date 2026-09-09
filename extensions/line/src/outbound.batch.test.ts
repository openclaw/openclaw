// Line tests cover outbound payload batching (issue #142734).
import { beforeEach, describe, expect, it, vi } from "vitest";

const runtimeStub = vi.hoisted(() => {
  const sendResult = () => ({ messageId: "m1", messageIds: ["m1"] });
  return {
    pushMessageLine: vi.fn(sendResult),
    pushMessagesLine: vi.fn(sendResult),
    pushFlexMessage: vi.fn(sendResult),
    pushTemplateMessage: vi.fn(sendResult),
    pushLocationMessage: vi.fn(sendResult),
    pushTextMessageWithQuickReplies: vi.fn(sendResult),
    createQuickReplyItems: vi.fn(() => []),
    createFlexMessage: vi.fn((altText: string, contents: unknown) => ({
      type: "flex",
      altText,
      contents,
    })),
    createLocationMessage: vi.fn(() => ({ type: "location", title: "loc", address: "addr" })),
    sendMessageLine: vi.fn(sendResult),
  };
});

const outboundRuntimeStub = vi.hoisted(() => ({
  processLineMessage: vi.fn((text: string) => ({ text, flexMessages: [] })),
  createFlexMessage: vi.fn((altText: string, contents: unknown) => ({
    type: "flex",
    altText,
    contents,
  })),
  createLocationMessage: vi.fn(() => ({ type: "location", title: "loc", address: "addr" })),
  createQuickReplyItems: vi.fn(() => []),
  pushMessageLine: vi.fn(() => ({ messageId: "om", messageIds: ["om"] })),
  pushMessagesLine: vi.fn(() => ({ messageId: "om", messageIds: ["om"] })),
  pushFlexMessage: vi.fn(() => ({ messageId: "of", messageIds: ["of"] })),
  pushTemplateMessage: vi.fn(() => ({ messageId: "ot", messageIds: ["ot"] })),
  pushLocationMessage: vi.fn(() => ({ messageId: "ol", messageIds: ["ol"] })),
  pushTextMessageWithQuickReplies: vi.fn(() => ({ messageId: "oq", messageIds: ["oq"] })),
  sendMessageLine: vi.fn(() => ({ messageId: "os", messageIds: ["os"] })),
  buildTemplateMessageFromPayload: vi.fn(() => undefined),
}));

vi.mock("./runtime.js", () => ({
  getLineRuntime: () => ({
    channel: {
      line: runtimeStub,
      text: {
        chunkMarkdownText: (text: string) => text.split(String.fromCharCode(10).repeat(2)),
        resolveTextChunkLimit: undefined,
      },
    },
  }),
}));

vi.mock("./outbound.runtime.js", () => outboundRuntimeStub);

import { lineOutboundAdapter } from "./outbound.js";

const CFG = { channels: { line: { accounts: { acc: {} } } } };

describe("lineOutboundAdapter.sendPayload batching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("batches a card, its caption, and an image into one push request", async () => {
    await lineOutboundAdapter.sendPayload!({
      to: "line:user:Uabc",
      payload: {
        text: "caption",
        mediaUrls: ["https://example.com/image.jpg"],
        channelData: {
          line: {
            card: { type: "bubble", body: { type: "box", contents: [] } },
          },
        },
      },
      accountId: "acc",
      cfg: CFG,
    });

    // One request carries the card, its caption, and the image — exactly the
    // three parts the issue measured as three monthly messages before.
    expect(runtimeStub.pushMessagesLine).toHaveBeenCalledTimes(1);
    const [, messages] = runtimeStub.pushMessagesLine.mock.calls[0] as unknown as [
      string,
      Array<{ type: string }>,
    ];
    expect(messages.map((message) => message.type)).toEqual(["flex", "text", "image"]);
    expect(runtimeStub.pushFlexMessage).not.toHaveBeenCalled();
    expect(runtimeStub.pushMessageLine).not.toHaveBeenCalled();
  });

  it("keeps per-request batches within the five-message Reply limit", async () => {
    const longText = Array.from({ length: 7 }, (_, i) => `chunk ${i}`).join("\n\n");
    await lineOutboundAdapter.sendPayload!({
      to: "line:user:Uabc",
      payload: { text: longText },
      accountId: "acc",
      cfg: CFG,
    });

    expect(runtimeStub.pushMessagesLine).toHaveBeenCalledTimes(2);
    const firstBatch = runtimeStub.pushMessagesLine.mock.calls[0] as unknown as [
      string,
      Array<{ type: string }>,
    ];
    expect(firstBatch[1]).toHaveLength(5);
  });
});
