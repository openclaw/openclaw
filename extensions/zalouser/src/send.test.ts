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

function expectTextCall(index: number, text: unknown, options: Record<string, unknown>) {
  expect(mockSendText.mock.calls[index]?.slice(0, 3)).toEqual([
    "thread",
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
    ["_cap_", "cap", [{ start: 0, len: 3, st: TextStyle.Italic }]],
    ["```\n```", "", undefined],
  ] as const)("formats image caption %j", async (caption, text, styles) => {
    mockSendText.mockResolvedValueOnce(sendResult("mid-2"));
    await sendImageZalouser("thread", imageUrl, { ...imageOptions, caption });
    expectTextCall(0, text, {
      ...imageOptions,
      caption: undefined,
      mediaUrl: imageUrl,
      textStyles: styles,
    });
  });

  it.each(["send", "receipt"] as const)("retains acceptance on %s failure", async (failure) => {
    const cause = new Error("delivery failed");
    const fail = () => {
      throw cause;
    };
    const nested = failure === "send";
    const ids = nested ? ["first", "caption"] : ["first"];
    mockSendText.mockResolvedValueOnce(sendResult("first"));
    if (nested) {
      mockSendText.mockImplementationOnce(async (_thread, _text, _options, report) => {
        await report?.(sendResult("caption"));
        return fail();
      });
    }
    const onDeliveryResult = nested ? undefined : fail;
    await expect(
      sendMessageZalouser("thread", "a".repeat(2001), { onDeliveryResult }),
    ).rejects.toMatchObject({
      code: "CHANNEL_PARTIAL_DELIVERY",
      message: cause.message,
      cause,
      deliveryResult: {
        messageIds: ids,
        receipt: {
          parts: ids.map((platformMessageId) => expect.objectContaining({ platformMessageId })),
        },
        visibleReplySent: true,
      },
    });
    expect(mockSendText).toHaveBeenCalledTimes(ids.length);
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
      expectTextCall(0, newline ? `${"a".repeat(1995)}\n\n` : expect.any(String), {
        ...options,
        ...(newline
          ? { textStyles: [{ start: 0, len: 1995, st: TextStyle.Bold }] }
          : { caption: undefined, mediaUrl: imageUrl }),
      });
      expectTextCall(
        1,
        newline ? "second paragraph" : expect.any(String),
        newline ? { ...options, textStyles: undefined } : { mediaUrl: undefined },
      );
      expect(result).toMatchObject({ messageId: "last" });
    },
  );
});
