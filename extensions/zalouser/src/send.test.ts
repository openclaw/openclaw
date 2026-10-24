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
    const cause = new Error("voice send failed");
    mockSendText
      .mockResolvedValueOnce(sendResult("mid-first"))
      .mockImplementationOnce(async (_threadId, _text, _options, onDeliveryResult) => {
        const accepted = sendResult("mid-caption");
        await onDeliveryResult?.(accepted);
        throw cause;
      });

    await expect(sendMessageZalouser("thread", "a".repeat(2001))).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      message: "voice send failed",
      cause,
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

  it.each(["newline", "media caption"] as const)(
    "preserves formatted %s across two sends",
    async (mode) => {
      const newline = mode === "newline";
      const text = newline
        ? `**${"a".repeat(1995)}**\n\nsecond paragraph`
        : "\t".repeat(500) + "a".repeat(1500);
      const options = {
        ...imageOptions,
        ...(newline ? { textChunkMode: "newline" as const } : {}),
      };
      mockSendText
        .mockResolvedValueOnce(sendResult("first"))
        .mockResolvedValueOnce(sendResult("last"));
      const result = newline
        ? await sendMessageZalouser("thread", text, options)
        : await sendImageZalouser("thread", imageUrl, { ...options, caption: text });

      expect(mockSendText).toHaveBeenCalledTimes(2);
      expect(mockSendText.mock.calls.map((call) => call[1]).join("")).toBe(
        parseZalouserTextStyles(text).text,
      );
      expectTextCall(0, "thread", newline ? `${"a".repeat(1995)}\n\n` : expect.any(String), {
        ...options,
        ...(newline
          ? { textStyles: [{ start: 0, len: 1995, st: TextStyle.Bold }] }
          : { caption: undefined, mediaUrl: imageUrl }),
      });
      expectTextCall(
        1,
        "thread",
        newline ? "second paragraph" : expect.any(String),
        newline ? { ...options, textStyles: undefined } : { mediaUrl: undefined },
      );
      expect(result).toMatchObject({ messageId: "last" });
    },
  );
});
