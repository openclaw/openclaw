import { beforeEach, describe, expect, it, vi } from "vitest";
import { createZalouserSendReceipt } from "./send-receipt.js";
import { sendImageZalouser, sendMessageZalouser } from "./send.js";
import { parseZalouserTextStyles } from "./text-styles.js";
import { sendZaloTextMessage } from "./zalo-js.js";
import { TextStyle } from "./zca-constants.js";

vi.mock("./zalo-js.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./zalo-js.js")>()),
  sendZaloTextMessage: vi.fn(),
}));

const mockSendText = vi.mocked(sendZaloTextMessage);

function sendResult(messageId: string, threadId = "thread") {
  return {
    messageId,
    receipt: createZalouserSendReceipt({ messageId, threadId, kind: "text" }),
  };
}

function expectTextCall(
  index: number,
  thread: string,
  text: unknown,
  options: Record<string, unknown>,
) {
  expect(mockSendText.mock.calls[index]?.slice(0, 3)).toEqual([
    thread,
    text,
    expect.objectContaining(options),
  ]);
}

const imageOptions = { profile: "p2", isGroup: false, textMode: "markdown" as const };
const imageUrl = "https://example.com/a.png";

describe("zalouser send helpers", () => {
  beforeEach(() => {
    mockSendText.mockReset();
  });

  it.each([
    {
      name: "formats image captions in markdown mode",
      caption: "_cap_",
      text: "cap",
      styles: [{ start: 0, len: 3, st: TextStyle.Italic }],
    },
    {
      name: "does not retain an empty raw markdown caption",
      caption: "```\n```",
      text: "",
      styles: undefined,
    },
  ])("$name", async ({ caption, text, styles }) => {
    mockSendText.mockResolvedValueOnce(sendResult("mid-2", "thread-2"));
    await sendImageZalouser("thread-2", imageUrl, { ...imageOptions, caption });
    expectTextCall(0, "thread-2", text, {
      ...imageOptions,
      caption: undefined,
      mediaUrl: imageUrl,
      textStyles: styles,
    });
  });

  it("combines earlier chunks with a failed chunk's partial receipt without duplicate parts", async () => {
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-first"))
      .mockImplementationOnce(async (_threadId, _text, _options, onDeliveryResult) => {
        const accepted = sendResult("mid-caption");
        await onDeliveryResult?.(accepted);
        throw new Error("voice send failed");
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
    expectTextCall(0, "thread-2d-2", `${"a".repeat(1995)}\n\n`, {
      profile: "p2d-2",
      isGroup: false,
      textMode: "markdown",
      textChunkMode: "newline",
      textStyles: [{ start: 0, len: 1995, st: TextStyle.Bold }],
    });
    expectTextCall(1, "thread-2d-2", "second paragraph", {
      profile: "p2d-2",
      isGroup: false,
      textMode: "markdown",
      textChunkMode: "newline",
      textStyles: undefined,
    });
    expect(result).toMatchObject({ messageId: "mid-2d-4" });
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
    expectTextCall(0, "thread-2e", expect.any(String), {
      profile: "p2e",
      caption: undefined,
      isGroup: false,
      mediaUrl: "https://example.com/long.png",
      textMode: "markdown",
    });
    expectTextCall(1, "thread-2e", expect.any(String), { mediaUrl: undefined });
    expect(result).toMatchObject({ messageId: "mid-2e-2" });
  });
});
