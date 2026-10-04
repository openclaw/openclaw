// Zalouser tests cover send plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createZalouserSendReceipt } from "./send-receipt.js";
import { sendImageZalouser, sendMessageZalouser, sendReactionZalouser } from "./send.js";
import { parseZalouserTextStyles } from "./text-styles.js";
import { sendZaloReaction, sendZaloTextMessage } from "./zalo-js.js";
import { TextStyle } from "./zca-constants.js";

vi.mock("./zalo-js.js", () => ({
  sendZaloTextMessage: vi.fn(),
  sendZaloReaction: vi.fn(),
}));

const mockSendText = vi.mocked(sendZaloTextMessage);
const mockSendReaction = vi.mocked(sendZaloReaction);

function sendResult(
  messageId: string,
  threadId = "thread",
): {
  ok: true;
  messageId: string;
  receipt: ReturnType<typeof createZalouserSendReceipt>;
} {
  return {
    ok: true,
    messageId,
    receipt: createZalouserSendReceipt({ messageId, threadId, kind: "text" }),
  };
}

function sendFailure(error: string, threadId = "thread") {
  return {
    ok: false,
    error,
    receipt: createZalouserSendReceipt({ threadId, kind: "unknown" }),
  };
}

function requireSendTextCall(callIndex: number) {
  const call = mockSendText.mock.calls[callIndex];
  if (!call) {
    throw new Error(`expected send text call ${callIndex + 1}`);
  }
  return call;
}

function requireSendTextOptions(callIndex: number) {
  const options = requireSendTextCall(callIndex)[2];
  if (!options) {
    throw new Error(`expected send text call ${callIndex + 1} options`);
  }
  return options;
}

function expectSendTextOptions(callIndex: number, fields: Record<string, unknown>) {
  expect(requireSendTextOptions(callIndex)).toEqual(expect.objectContaining(fields));
}

describe("zalouser send helpers", () => {
  beforeEach(() => {
    mockSendText.mockReset();
    mockSendReaction.mockReset();
  });

  it("keeps plain text literal by default", async () => {
    mockSendText.mockResolvedValueOnce(sendResult("mid-1", "thread-1"));

    const result = await sendMessageZalouser("thread-1", "**hello**", {
      profile: "default",
      isGroup: true,
    });

    expect(requireSendTextCall(0)[0]).toBe("thread-1");
    expect(requireSendTextCall(0)[1]).toBe("**hello**");
    expectSendTextOptions(0, { profile: "default", isGroup: true });
    expect(result).toMatchObject({ ok: true, messageId: "mid-1" });
    expect(result.receipt.primaryPlatformMessageId).toBe("mid-1");
  });

  it("formats image captions in markdown mode", async () => {
    mockSendText.mockResolvedValueOnce(sendResult("mid-2", "thread-2"));

    await sendImageZalouser("thread-2", "https://example.com/a.png", {
      profile: "p2",
      caption: "_cap_",
      isGroup: false,
      textMode: "markdown",
    });

    expect(requireSendTextCall(0)[0]).toBe("thread-2");
    expect(requireSendTextCall(0)[1]).toBe("cap");
    expectSendTextOptions(0, {
      profile: "p2",
      caption: undefined,
      isGroup: false,
      mediaUrl: "https://example.com/a.png",
      textMode: "markdown",
      textStyles: [{ start: 0, len: 3, st: TextStyle.Italic }],
    });
  });

  it("does not keep the raw markdown caption as a media fallback after formatting", async () => {
    mockSendText.mockResolvedValueOnce(sendResult("mid-2b", "thread-2"));

    await sendImageZalouser("thread-2", "https://example.com/a.png", {
      profile: "p2",
      caption: "```\n```",
      isGroup: false,
      textMode: "markdown",
    });

    expect(requireSendTextCall(0)[0]).toBe("thread-2");
    expect(requireSendTextCall(0)[1]).toBe("");
    expectSendTextOptions(0, {
      profile: "p2",
      caption: undefined,
      isGroup: false,
      mediaUrl: "https://example.com/a.png",
      textMode: "markdown",
      textStyles: undefined,
    });
  });

  it("reports each completed internal chunk before a later chunk fails", async () => {
    const firstResult = sendResult("mid-progress-1", "thread-progress");
    mockSendText
      .mockResolvedValueOnce(firstResult)
      .mockResolvedValueOnce(sendFailure("second chunk failed", "thread-progress"));
    const onDeliveryResult = vi.fn();

    await expect(
      sendMessageZalouser("thread-progress", "a".repeat(2001), {
        textChunkLimit: 2000,
        onDeliveryResult,
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      message: "second chunk failed",
      deliveryResult: { messageIds: ["mid-progress-1"], visibleReplySent: true },
    });

    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(onDeliveryResult).toHaveBeenCalledOnce();
    expect(onDeliveryResult).toHaveBeenCalledWith(firstResult);
    expect(requireSendTextOptions(0)).not.toHaveProperty("onDeliveryResult");
  });

  it.each([false, true])(
    "preserves earlier receipts after a later authority refusal (progress callback=%s)",
    async (reportProgress) => {
      const cause = new Error("Zalouser send authority ended");
      mockSendText
        .mockResolvedValueOnce(sendResult("mid-1"))
        .mockResolvedValueOnce(sendResult("mid-2"))
        .mockRejectedValueOnce(cause);
      const onDeliveryResult = reportProgress ? vi.fn() : undefined;

      await expect(
        sendMessageZalouser("thread", "a".repeat(4001), { onDeliveryResult }),
      ).rejects.toMatchObject({
        code: "CHANNEL_PARTIAL_DELIVERY",
        cause,
        deliveryResult: {
          messageIds: ["mid-1", "mid-2"],
          receipt: {
            platformMessageIds: ["mid-1", "mid-2"],
            parts: [
              expect.objectContaining({ platformMessageId: "mid-1" }),
              expect.objectContaining({ platformMessageId: "mid-2" }),
            ],
          },
          visibleReplySent: true,
        },
      });
      expect(mockSendText).toHaveBeenCalledTimes(3);
      if (onDeliveryResult) {
        expect(onDeliveryResult).toHaveBeenCalledTimes(2);
      }
    },
  );

  it("combines earlier chunks with a failed chunk's partial receipt without duplicate parts", async () => {
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-first"))
      .mockImplementationOnce(async (_threadId, _text, _options, onDeliveryResult) => {
        const accepted = sendResult("mid-caption");
        await onDeliveryResult?.(accepted);
        return { ...accepted, ok: false, error: "voice send failed" };
      });

    await expect(sendMessageZalouser("thread", "a".repeat(2001))).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      message: "voice send failed",
      deliveryResult: {
        messageIds: ["mid-first", "mid-caption"],
        receipt: {
          parts: [
            expect.objectContaining({ platformMessageId: "mid-first" }),
            expect.objectContaining({ platformMessageId: "mid-caption" }),
          ],
        },
        visibleReplySent: true,
      },
    });
  });

  it("retains nested progress when the transport throws without a progress subscriber", async () => {
    const cause = new Error("voice authority ended");
    mockSendText.mockImplementationOnce(async (_threadId, _text, _options, onDeliveryResult) => {
      await onDeliveryResult?.(sendResult("mid-caption"));
      throw cause;
    });

    await expect(sendMessageZalouser("thread", "caption")).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause,
      deliveryResult: { messageIds: ["mid-caption"], visibleReplySent: true },
    });
  });

  it("retains provider acceptance when the delivery callback fails", async () => {
    const cause = new Error("receipt persistence failed");
    mockSendText.mockResolvedValueOnce(sendResult("mid-accepted"));

    await expect(
      sendMessageZalouser("thread", "a".repeat(2001), {
        onDeliveryResult: () => {
          throw cause;
        },
      }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      cause,
      deliveryResult: { messageIds: ["mid-accepted"], visibleReplySent: true },
    });
    expect(mockSendText).toHaveBeenCalledOnce();
  });

  it("preserves a refusal before any chunk was accepted", async () => {
    const cause = new Error("Zalouser send authority ended");
    mockSendText.mockRejectedValueOnce(cause);

    await expect(sendMessageZalouser("thread", "a".repeat(2001))).rejects.toBe(cause);
    expect(mockSendText).toHaveBeenCalledOnce();
  });

  it("preserves text styles when splitting long formatted markdown", async () => {
    const text = `**${"a".repeat(2501)}**`;
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-2d-1", "thread-2d"))
      .mockResolvedValueOnce(sendResult("mid-2d-2", "thread-2d"));

    const result = await sendMessageZalouser("thread-2d", text, {
      profile: "p2d",
      isGroup: false,
      textMode: "markdown",
    });

    expect(requireSendTextCall(0)[0]).toBe("thread-2d");
    expect(requireSendTextCall(0)[1]).toBe("a".repeat(2000));
    expectSendTextOptions(0, {
      profile: "p2d",
      isGroup: false,
      textMode: "markdown",
      textStyles: [{ start: 0, len: 2000, st: TextStyle.Bold }],
    });
    expect(requireSendTextCall(1)[0]).toBe("thread-2d");
    expect(requireSendTextCall(1)[1]).toBe("a".repeat(501));
    expectSendTextOptions(1, {
      profile: "p2d",
      isGroup: false,
      textMode: "markdown",
      textStyles: [{ start: 0, len: 501, st: TextStyle.Bold }],
    });
    expect(result).toMatchObject({ ok: true, messageId: "mid-2d-2" });
  });

  it("preserves formatted text and styles when newline chunk mode splits after parsing", async () => {
    const text = `**${"a".repeat(1995)}**\n\nsecond paragraph`;
    const formatted = parseZalouserTextStyles(text);
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-2d-3", "thread-2d-2"))
      .mockResolvedValueOnce(sendResult("mid-2d-4", "thread-2d-2"));

    const result = await sendMessageZalouser("thread-2d-2", text, {
      profile: "p2d-2",
      isGroup: false,
      textMode: "markdown",
      textChunkMode: "newline",
    });

    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText.mock.calls.map((call) => call[1]).join("")).toBe(formatted.text);
    expect(requireSendTextCall(0)[0]).toBe("thread-2d-2");
    expect(requireSendTextCall(0)[1]).toBe(`${"a".repeat(1995)}\n\n`);
    expectSendTextOptions(0, {
      profile: "p2d-2",
      isGroup: false,
      textMode: "markdown",
      textChunkMode: "newline",
      textStyles: [{ start: 0, len: 1995, st: TextStyle.Bold }],
    });
    expect(requireSendTextCall(1)[0]).toBe("thread-2d-2");
    expect(requireSendTextCall(1)[1]).toBe("second paragraph");
    expectSendTextOptions(1, {
      profile: "p2d-2",
      isGroup: false,
      textMode: "markdown",
      textChunkMode: "newline",
      textStyles: undefined,
    });
    expect(result).toMatchObject({ ok: true, messageId: "mid-2d-4" });
  });

  it.each([
    {
      name: "fenced code with hard limits",
      text: "```ts\nconst alpha = 1;\nconst beta = 2;\n```",
      textChunkLimit: 16,
      textChunkMode: "length" as const,
      expected: ["const alpha = 1;", "\nconst beta = 2;"],
    },
    {
      name: "tables with newline-preferred limits",
      text: "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |",
      textChunkLimit: 24,
      textChunkMode: "newline" as const,
      expected: ["| A | B |\n| --- | --- |\n", "| 1 | 2 |\n| 3 | 4 |"],
    },
    {
      name: "repeated whitespace around paragraph boundaries",
      text: "alpha  beta\n\ngamma delta",
      textChunkLimit: 12,
      textChunkMode: "newline" as const,
      expected: ["alpha  beta\n", "\ngamma delta"],
    },
  ])("preserves exact rendered chunks for $name", async (fixture) => {
    mockSendText.mockResolvedValue(sendResult("mid-parity", "thread-parity"));

    await sendMessageZalouser("thread-parity", fixture.text, {
      textMode: "markdown",
      textChunkLimit: fixture.textChunkLimit,
      textChunkMode: fixture.textChunkMode,
    });

    const renderedChunks = mockSendText.mock.calls.map((call) => call[1]);
    expect(renderedChunks).toEqual(fixture.expected);
    expect(renderedChunks.join("")).toBe(parseZalouserTextStyles(fixture.text).text);
  });

  it("respects an explicit text chunk limit when splitting formatted markdown", async () => {
    const text = `**${"a".repeat(1501)}**`;
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-2d-5", "thread-2d-3"))
      .mockResolvedValueOnce(sendResult("mid-2d-6", "thread-2d-3"));

    const result = await sendMessageZalouser("thread-2d-3", text, {
      profile: "p2d-3",
      isGroup: false,
      textMode: "markdown",
      textChunkLimit: 1200,
    } as never);

    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(requireSendTextCall(0)[0]).toBe("thread-2d-3");
    expect(requireSendTextCall(0)[1]).toBe("a".repeat(1200));
    expectSendTextOptions(0, {
      profile: "p2d-3",
      isGroup: false,
      textMode: "markdown",
      textChunkLimit: 1200,
      textStyles: [{ start: 0, len: 1200, st: TextStyle.Bold }],
    });
    expect(requireSendTextCall(1)[0]).toBe("thread-2d-3");
    expect(requireSendTextCall(1)[1]).toBe("a".repeat(301));
    expectSendTextOptions(1, {
      profile: "p2d-3",
      isGroup: false,
      textMode: "markdown",
      textChunkLimit: 1200,
      textStyles: [{ start: 0, len: 301, st: TextStyle.Bold }],
    });
    expect(result).toMatchObject({ ok: true, messageId: "mid-2d-6" });
  });

  it("sends overflow markdown captions as follow-up text after the media message", async () => {
    const caption = "\t".repeat(500) + "a".repeat(1500);
    const formatted = parseZalouserTextStyles(caption);
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-2e-1", "thread-2e"))
      .mockResolvedValueOnce(sendResult("mid-2e-2", "thread-2e"));

    const result = await sendImageZalouser("thread-2e", "https://example.com/long.png", {
      profile: "p2e",
      caption,
      isGroup: false,
      textMode: "markdown",
    });

    expect(mockSendText).toHaveBeenCalledTimes(2);
    expect(mockSendText.mock.calls.map((call) => call[1]).join("")).toBe(formatted.text);
    expect(requireSendTextCall(0)[0]).toBe("thread-2e");
    expect(typeof requireSendTextCall(0)[1]).toBe("string");
    expectSendTextOptions(0, {
      profile: "p2e",
      caption: undefined,
      isGroup: false,
      mediaUrl: "https://example.com/long.png",
      textMode: "markdown",
    });
    expect(requireSendTextCall(1)[0]).toBe("thread-2e");
    expect(typeof requireSendTextCall(1)[1]).toBe("string");
    expect(requireSendTextOptions(1).mediaUrl).toBeUndefined();
    expect(result).toMatchObject({ ok: true, messageId: "mid-2e-2" });
  });

  it("delegates reaction helper to JS transport", async () => {
    mockSendReaction.mockResolvedValueOnce({ ok: true });

    const result = await sendReactionZalouser({
      threadId: "thread-5",
      profile: "p5",
      isGroup: true,
      msgId: "100",
      cliMsgId: "200",
      emoji: "👍",
    });

    expect(mockSendReaction).toHaveBeenCalledWith({
      profile: "p5",
      threadId: "thread-5",
      isGroup: true,
      msgId: "100",
      cliMsgId: "200",
      emoji: "👍",
      remove: undefined,
    });
    expect(result).toMatchObject({ ok: true, error: undefined });
    expect(result.receipt.platformMessageIds).toStrictEqual([]);
  });
});
