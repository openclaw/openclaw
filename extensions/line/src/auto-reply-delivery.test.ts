// Line tests cover auto reply delivery plugin behavior.
import { describe, expect, it, vi } from "vitest";
import type { LineAutoReplyDeps } from "./auto-reply-delivery.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { sendLineReplyChunks } from "./reply-chunks.js";
import { createLineSendReceipt } from "./send-receipt.js";

const createFlexMessage = (altText: string, contents: unknown) => ({
  type: "flex" as const,
  altText,
  contents,
});

const createImageMessage = (url: string) => ({
  type: "image" as const,
  originalContentUrl: url,
  previewImageUrl: url,
});

const createLocationMessage = (location: {
  title: string;
  address: string;
  latitude: number;
  longitude: number;
}) => ({
  type: "location" as const,
  ...location,
});

describe("deliverLineAutoReply", () => {
  const LINE_TEST_CFG = { channels: { line: { accounts: { acc: {} } } } };
  const baseDeliveryParams = {
    cfg: LINE_TEST_CFG,
    to: "line:user:1",
    replyToken: "token",
    replyTokenUsed: false,
    accountId: "acc",
    textLimit: 5000,
  };

  function createDeps(overrides?: Partial<LineAutoReplyDeps>) {
    const replyMessageLine = vi.fn(async () => ({}));
    const pushMessageLine = vi.fn(async () => ({}));
    const pushTextMessageWithQuickReplies = vi.fn(async () => ({}));
    const createTextMessageWithQuickReplies = vi.fn((text: string) => ({
      type: "text" as const,
      text,
    }));
    const createQuickReplyItems = vi.fn((labels: string[]) => ({ items: labels }));
    const pushMessagesLine = vi.fn(async () => ({
      messageId: "push",
      chatId: "u1",
      receipt: createLineSendReceipt({ messageId: "push", chatId: "u1", kind: "text" }),
    }));

    const deps: LineAutoReplyDeps = {
      buildTemplateMessageFromPayload: () => null,
      processLineMessage: (text) => ({ text, flexMessages: [] }),
      chunkMarkdownText: (text) => [text],
      sendLineReplyChunks,
      replyMessageLine,
      pushMessageLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
      createQuickReplyItems: createQuickReplyItems as LineAutoReplyDeps["createQuickReplyItems"],
      pushMessagesLine,
      createFlexMessage: createFlexMessage as LineAutoReplyDeps["createFlexMessage"],
      createImageMessage,
      createLocationMessage,
      ...overrides,
    };

    return {
      deps,
      replyMessageLine,
      pushMessageLine,
      pushTextMessageWithQuickReplies,
      createTextMessageWithQuickReplies,
      createQuickReplyItems,
      pushMessagesLine,
    };
  }

  it("packs rich + text into a single Reply API call when no quick replies (#65656)", async () => {
    // Without quick replies, the Reply API can carry up to 5 messages on
    // the same token; bundling rich/media with text avoids the free-plan
    // 429 Push API quota error. The previous split (text->Reply, Flex->Push)
    // would silently drop the table message on exhausted Push quota.
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const { deps, replyMessageLine, pushMessagesLine, createQuickReplyItems } = createDeps();

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [createFlexMessage("Card", { type: "bubble" }), { type: "text", text: "hello" }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(createQuickReplyItems).not.toHaveBeenCalled();
  });

  it("uses reply token for rich-only payloads", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const { deps, replyMessageLine, pushMessagesLine, createQuickReplyItems } = createDeps({
      processLineMessage: () => ({ text: "", flexMessages: [] }),
      chunkMarkdownText: () => [],
      sendLineReplyChunks: vi.fn(async () => ({ replyTokenUsed: false })),
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        {
          ...createFlexMessage("Card", { type: "bubble" }),
          quickReply: { items: ["A"] },
        },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(createQuickReplyItems).toHaveBeenCalledWith(["A"]);
  });

  it("uses fallback text for quick-reply-only payloads", async () => {
    const createTextMessageWithQuickReplies = vi.fn((text: string, _quickReplies: string[]) => ({
      type: "text" as const,
      text,
      quickReply: { items: ["A", "B"] },
    }));
    const lineData = {
      quickReplies: ["A", "B"],
    };
    const { deps, replyMessageLine, pushMessagesLine } = createDeps({
      createTextMessageWithQuickReplies:
        createTextMessageWithQuickReplies as LineAutoReplyDeps["createTextMessageWithQuickReplies"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        {
          type: "text",
          text: "Options:\n- A\n- B",
          quickReply: { items: ["A", "B"] },
        },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
  });

  it("sends rich messages before quick-reply text so quick replies remain visible", async () => {
    const createTextMessageWithQuickReplies = vi.fn((text: string, _quickReplies: string[]) => ({
      type: "text" as const,
      text,
      quickReply: { items: ["A"] },
    }));

    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
      quickReplies: ["A"],
    };
    const { deps, pushMessagesLine, replyMessageLine } = createDeps({
      createTextMessageWithQuickReplies:
        createTextMessageWithQuickReplies as LineAutoReplyDeps["createTextMessageWithQuickReplies"],
    });

    await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:user:1",
      [createFlexMessage("Card", { type: "bubble" })],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        {
          type: "text",
          text: "hello",
          quickReply: { items: ["A"] },
        },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    const pushOrder = pushMessagesLine.mock.invocationCallOrder[0];
    const replyOrder = replyMessageLine.mock.invocationCallOrder[0];
    expect(pushOrder).toBeLessThan(replyOrder);
  });

  it("overflows past the 5-slot Reply API limit to Push API (#65656)", async () => {
    // Total: 2 Flex + 4 text chunks = 6 messages.
    // Reply API max is 5 → 5 go in Reply, 1 overflows to Push.
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const chunkedText = ["chunk1", "chunk2", "chunk3", "chunk4"];
    const processLineMessageOverride = ((text: string) => ({
      text,
      flexMessages: [createFlexMessage("Table", { type: "bubble" })],
    })) as LineAutoReplyDeps["processLineMessage"];
    const { deps, replyMessageLine, pushMessagesLine } = createDeps({
      processLineMessage: processLineMessageOverride,
      chunkMarkdownText: () => chunkedText,
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(replyMessageLine).toHaveBeenCalledTimes(1);
    // 2 Flex + first 3 text chunks fit; chunk4 overflows.
    expect(replyMessageLine).toHaveBeenCalledWith(
      "token",
      [
        createFlexMessage("Card", { type: "bubble" }),
        createFlexMessage("Table", { type: "bubble" }),
        { type: "text", text: "chunk1" },
        { type: "text", text: "chunk2" },
        { type: "text", text: "chunk3" },
      ],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
    expect(pushMessagesLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:user:1",
      [{ type: "text", text: "chunk4" }],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });

  it("falls back to Push API for the whole batch when Reply API errors (#65656)", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const failingReplyMessageLine = vi.fn(async () => {
      throw new Error("reply quota exhausted");
    });
    const { deps, pushMessagesLine } = createDeps({
      replyMessageLine: failingReplyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { text: "hello", channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(failingReplyMessageLine).toHaveBeenCalledTimes(1);
    // Failure pushed both rich + text via Push API.
    expect(pushMessagesLine).toHaveBeenCalled();
  });

  it("falls back to push when reply token delivery fails", async () => {
    const lineData = {
      flexMessage: { altText: "Card", contents: { type: "bubble" } },
    };
    const failingReplyMessageLine = vi.fn(async () => {
      throw new Error("reply failed");
    });
    const { deps, pushMessagesLine } = createDeps({
      processLineMessage: () => ({ text: "", flexMessages: [] }),
      chunkMarkdownText: () => [],
      replyMessageLine: failingReplyMessageLine as LineAutoReplyDeps["replyMessageLine"],
    });

    const result = await deliverLineAutoReply({
      ...baseDeliveryParams,
      payload: { channelData: { line: lineData } },
      lineData,
      deps,
    });

    expect(result.replyTokenUsed).toBe(true);
    expect(failingReplyMessageLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:user:1",
      [createFlexMessage("Card", { type: "bubble" })],
      { cfg: LINE_TEST_CFG, accountId: "acc" },
    );
  });
});
