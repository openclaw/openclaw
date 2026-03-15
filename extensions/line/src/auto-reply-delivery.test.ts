import { describe, expect, it, vi } from "vitest";
import type { LineAutoReplyDeps } from "./auto-reply-delivery.js";
import { deliverLineAutoReply } from "./auto-reply-delivery.js";
import { sendLineReplyChunks } from "./reply-chunks.js";

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
  const baseDeliveryParams = {
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
    const pushMessagesLine = vi.fn(async () => ({ messageId: "push", chatId: "u1" }));

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

  it("uses reply token for text before sending rich messages", async () => {
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
    expect(replyMessageLine).toHaveBeenCalledWith("token", [{ type: "text", text: "hello" }], {
      accountId: "acc",
    });
    expect(pushMessagesLine).toHaveBeenCalledTimes(1);
    expect(pushMessagesLine).toHaveBeenCalledWith(
      "line:user:1",
      [createFlexMessage("Card", { type: "bubble" })],
      { accountId: "acc" },
    );
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
      { accountId: "acc" },
    );
    expect(pushMessagesLine).not.toHaveBeenCalled();
    expect(createQuickReplyItems).toHaveBeenCalledWith(["A"]);
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
      { accountId: "acc" },
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
      { accountId: "acc" },
    );
    const pushOrder = pushMessagesLine.mock.invocationCallOrder[0];
    const replyOrder = replyMessageLine.mock.invocationCallOrder[0];
    expect(pushOrder).toBeLessThan(replyOrder);
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
      { accountId: "acc" },
    );
  });

  describe("sticker delivery", () => {
    it("sends sticker only when payload has valid sticker (text is dropped)", async () => {
      const { deps, replyMessageLine, pushMessagesLine } = createDeps();

      const result = await deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { text: "おはよう！", sticker: { raw: "11537:52002734" } },
        lineData: {},
        deps,
      });

      expect(result.replyTokenUsed).toBe(true);
      expect(replyMessageLine).toHaveBeenCalledTimes(1);
      expect(replyMessageLine).toHaveBeenCalledWith(
        "token",
        [{ type: "sticker", packageId: "11537", stickerId: "52002734" }],
        { accountId: "acc" },
      );
      // Text should not be sent
      expect(pushMessagesLine).not.toHaveBeenCalled();
    });

    it("sends sticker alone when no text", async () => {
      const { deps, replyMessageLine } = createDeps();

      await deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { sticker: { raw: "446:1988" } },
        lineData: {},
        deps,
      });

      expect(replyMessageLine).toHaveBeenCalledWith(
        "token",
        [{ type: "sticker", packageId: "446", stickerId: "1988" }],
        { accountId: "acc" },
      );
    });

    it("falls back to text only when sticker raw is invalid (non-numeric)", async () => {
      const { deps, replyMessageLine, pushMessagesLine } = createDeps();

      await deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { text: "テスト", sticker: { raw: "not-valid" } },
        lineData: {},
        deps,
      });

      // Should send text, not sticker
      expect(replyMessageLine).toHaveBeenCalledWith("token", [{ type: "text", text: "テスト" }], {
        accountId: "acc",
      });
      expect(pushMessagesLine).not.toHaveBeenCalled();
    });

    it("sends text normally when no sticker", async () => {
      const { deps, replyMessageLine } = createDeps();

      await deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: { text: "普通のメッセージ" },
        lineData: {},
        deps,
      });

      expect(replyMessageLine).toHaveBeenCalledWith(
        "token",
        [{ type: "text", text: "普通のメッセージ" }],
        { accountId: "acc" },
      );
    });

    it("does not reject when both sticker reply and error push fail", async () => {
      const failReplyMock = vi.fn(async () => {
        throw new Error("400 Bad Request");
      });
      const pushMessagesMock = vi.fn(async () => {
        throw new Error("push also failed");
      });
      const { deps } = createDeps({
        replyMessageLine: failReplyMock as LineAutoReplyDeps["replyMessageLine"],
        pushMessagesLine: pushMessagesMock as LineAutoReplyDeps["pushMessagesLine"],
      });

      // Should not throw even when both sticker send and error text push fail
      await expect(
        deliverLineAutoReply({
          ...baseDeliveryParams,
          payload: { sticker: { raw: "99999:00000" } },
          lineData: {},
          deps,
        }),
      ).resolves.toEqual({ replyTokenUsed: false });

      expect(pushMessagesMock).toHaveBeenCalledWith(
        "line:user:1",
        [
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("スタンプ送信エラー"),
          }),
        ],
        { accountId: "acc" },
      );
    });

    it("sends sticker via lineData.sticker (channelData path)", async () => {
      const { deps, replyMessageLine } = createDeps();

      await deliverLineAutoReply({
        ...baseDeliveryParams,
        payload: {},
        lineData: { sticker: { packageId: "446", stickerId: "1988" } },
        deps,
      });

      expect(replyMessageLine).toHaveBeenCalledWith(
        "token",
        [{ type: "sticker", packageId: "446", stickerId: "1988" }],
        { accountId: "acc" },
      );
    });
  });
});
