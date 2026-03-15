import { describe, expect, it, vi } from "vitest";
import { logVerbose } from "../../../../src/globals.js";
import { sleep } from "../../../../src/utils.js";
import { loadWebMedia } from "../media.js";
import { deliverWebReply } from "./deliver-reply.js";
import type { WebInboundMsg } from "./types.js";

vi.mock("../../../../src/globals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/globals.js")>();
  return {
    ...actual,
    shouldLogVerbose: vi.fn(() => true),
    logVerbose: vi.fn(),
  };
});

vi.mock("../media.js", () => ({
  loadWebMedia: vi.fn(),
}));

vi.mock("../../../../src/utils.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../src/utils.js")>();
  return {
    ...actual,
    sleep: vi.fn(async () => {}),
  };
});

function makeMsg(): WebInboundMsg {
  return {
    from: "+10000000000",
    to: "+20000000000",
    id: "msg-1",
    reply: vi.fn(async () => undefined),
    sendMedia: vi.fn(async () => undefined),
  } as unknown as WebInboundMsg;
}

function mockLoadedImageMedia() {
  (
    loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
  ).mockResolvedValueOnce({
    buffer: Buffer.from("img"),
    contentType: "image/jpeg",
    kind: "image",
  });
}

function mockFirstSendMediaFailure(msg: WebInboundMsg, message: string) {
  (
    msg.sendMedia as unknown as { mockRejectedValueOnce: (v: unknown) => void }
  ).mockRejectedValueOnce(new Error(message));
}

function mockFirstReplyFailure(msg: WebInboundMsg, message: string) {
  (msg.reply as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(
    new Error(message),
  );
}

function mockSecondReplySuccess(msg: WebInboundMsg) {
  (msg.reply as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
    undefined,
  );
}

function createNeverSettlingPromise<T>() {
  return new Promise<T>(() => {});
}

const replyLogger = {
  info: vi.fn(),
  warn: vi.fn(),
};

async function expectReplySuppressed(replyResult: { text: string; isReasoning?: boolean }) {
  const msg = makeMsg();
  await deliverWebReply({
    replyResult,
    msg,
    maxMediaBytes: 1024 * 1024,
    textLimit: 200,
    replyLogger,
    skipLog: true,
  });
  expect(msg.reply).not.toHaveBeenCalled();
  expect(msg.sendMedia).not.toHaveBeenCalled();
}

describe("deliverWebReply", () => {
  it("suppresses payloads flagged as reasoning", async () => {
    await expectReplySuppressed({ text: "Reasoning:\n_hidden_", isReasoning: true });
  });

  it("suppresses payloads that start with reasoning prefix text", async () => {
    await expectReplySuppressed({ text: "   \n Reasoning:\n_hidden_" });
  });

  it("does not suppress messages that mention Reasoning: mid-text", async () => {
    const msg = makeMsg();

    await deliverWebReply({
      replyResult: { text: "Intro line\nReasoning: appears in content but is not a prefix" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledWith(
      "Intro line\nReasoning: appears in content but is not a prefix",
    );
  });

  it("sends chunked text replies and logs a summary", async () => {
    const msg = makeMsg();

    await deliverWebReply({
      replyResult: { text: "aaaaaa" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 3,
      replyLogger,
      skipLog: true,
    });

    expect(msg.reply).toHaveBeenCalledTimes(2);
    expect(msg.reply).toHaveBeenNthCalledWith(1, "aaa");
    expect(msg.reply).toHaveBeenNthCalledWith(2, "aaa");
    expect(replyLogger.info).toHaveBeenCalledWith(expect.any(Object), "auto-reply sent (text)");
  });

  it.each(["connection closed", "operation timed out"])(
    "retries text send on transient failure: %s",
    async (errorMessage) => {
      const msg = makeMsg();
      mockFirstReplyFailure(msg, errorMessage);
      mockSecondReplySuccess(msg);

      await deliverWebReply({
        replyResult: { text: "hi" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        skipLog: true,
      });

      expect(msg.reply).toHaveBeenCalledTimes(2);
      expect(sleep).toHaveBeenCalledWith(500);
    },
  );

  it("stops sending later text chunks after commentary delivery is aborted", async () => {
    const msg = makeMsg();
    const abortController = new AbortController();
    (sleep as unknown as { mockClear: () => void }).mockClear();
    (
      msg.reply as unknown as { mockImplementationOnce: (fn: () => Promise<void>) => void }
    ).mockImplementationOnce(async () => {
      const abortError = new Error("commentary aborted");
      abortError.name = "AbortError";
      abortController.abort(abortError);
    });

    await expect(
      deliverWebReply({
        replyResult: { text: "aaaaaa" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 3,
        replyLogger,
        abortSignal: abortController.signal,
        skipLog: true,
      }),
    ).rejects.toThrow("commentary aborted");

    expect(msg.reply).toHaveBeenCalledTimes(1);
  });

  it("stops retry backoff once commentary delivery is aborted", async () => {
    const msg = makeMsg();
    const abortController = new AbortController();
    (sleep as unknown as { mockClear: () => void }).mockClear();
    (
      msg.reply as unknown as { mockImplementationOnce: (fn: () => Promise<void>) => void }
    ).mockImplementationOnce(async () => {
      const abortError = new Error("commentary aborted");
      abortError.name = "AbortError";
      abortController.abort(abortError);
      throw new Error("connection closed");
    });

    await expect(
      deliverWebReply({
        replyResult: { text: "hi" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        abortSignal: abortController.signal,
        skipLog: true,
      }),
    ).rejects.toThrow("commentary aborted");

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("times out a hung text send instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const msg = makeMsg();
      (
        msg.reply as unknown as { mockImplementationOnce: (fn: () => Promise<void>) => void }
      ).mockImplementationOnce(() => createNeverSettlingPromise<void>());

      const deliveryPromise = deliverWebReply({
        replyResult: { text: "hi" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        timeoutMs: 25,
        skipLog: true,
      });
      const deliveryExpectation = expect(deliveryPromise).rejects.toThrow(
        "delivery timed out after 25ms",
      );

      await vi.advanceTimersByTimeAsync(25);
      await deliveryExpectation;
      expect(msg.reply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("times out a hung media send instead of waiting forever", async () => {
    vi.useFakeTimers();
    try {
      const msg = makeMsg();
      mockLoadedImageMedia();
      (
        msg.sendMedia as unknown as { mockImplementationOnce: (fn: () => Promise<void>) => void }
      ).mockImplementationOnce(() => createNeverSettlingPromise<void>());

      const deliveryPromise = deliverWebReply({
        replyResult: { text: "caption", mediaUrl: "http://example.com/img.jpg" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        timeoutMs: 25,
        skipLog: true,
      });
      const deliveryExpectation = expect(deliveryPromise).rejects.toThrow(
        "delivery timed out after 25ms",
      );

      await vi.advanceTimersByTimeAsync(25);
      await deliveryExpectation;
      expect(msg.sendMedia).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends image media with caption and then remaining text", async () => {
    const msg = makeMsg();
    const mediaLocalRoots = ["/tmp/workspace-work"];
    mockLoadedImageMedia();

    await deliverWebReply({
      replyResult: { text: "aaaaaa", mediaUrl: "http://example.com/img.jpg" },
      msg,
      mediaLocalRoots,
      maxMediaBytes: 1024 * 1024,
      textLimit: 3,
      replyLogger,
      skipLog: true,
    });

    expect(loadWebMedia).toHaveBeenCalledWith("http://example.com/img.jpg", {
      maxBytes: 1024 * 1024,
      localRoots: mediaLocalRoots,
    });

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        image: expect.any(Buffer),
        caption: "aaa",
        mimetype: "image/jpeg",
      }),
    );
    expect(msg.reply).toHaveBeenCalledWith("aaa");
    expect(replyLogger.info).toHaveBeenCalledWith(expect.any(Object), "auto-reply sent (media)");
    expect(logVerbose).toHaveBeenCalled();
  });

  it("retries media send on transient failure", async () => {
    const msg = makeMsg();
    mockLoadedImageMedia();
    mockFirstSendMediaFailure(msg, "socket reset");
    (
      msg.sendMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce(undefined);

    await deliverWebReply({
      replyResult: { text: "caption", mediaUrl: "http://example.com/img.jpg" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.sendMedia).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("falls back to text-only when the first media send fails", async () => {
    const msg = makeMsg();
    mockLoadedImageMedia();
    mockFirstSendMediaFailure(msg, "boom");

    await deliverWebReply({
      replyResult: { text: "caption", mediaUrl: "http://example.com/img.jpg" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 20,
      replyLogger,
      skipLog: true,
    });

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(
      String((msg.reply as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]?.[0]),
    ).toContain("⚠️ Media failed");
    expect(replyLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ mediaUrl: "http://example.com/img.jpg" }),
      "failed to send web media reply",
    );
  });

  it("times out a hung fallback text send after media failure", async () => {
    vi.useFakeTimers();
    try {
      const msg = makeMsg();
      mockLoadedImageMedia();
      mockFirstSendMediaFailure(msg, "boom");
      (
        msg.reply as unknown as { mockImplementationOnce: (fn: () => Promise<void>) => void }
      ).mockImplementationOnce(() => createNeverSettlingPromise<void>());

      const deliveryPromise = deliverWebReply({
        replyResult: { text: "caption", mediaUrl: "http://example.com/img.jpg" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 20,
        replyLogger,
        timeoutMs: 25,
        skipLog: true,
      });
      const deliveryExpectation = expect(deliveryPromise).rejects.toThrow(
        "delivery timed out after 25ms",
      );

      await vi.advanceTimersByTimeAsync(25);
      await deliveryExpectation;
      expect(msg.sendMedia).toHaveBeenCalledTimes(1);
      expect(msg.reply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("sends audio media as ptt voice note", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("aud"),
      contentType: "audio/ogg",
      kind: "audio",
    });

    await deliverWebReply({
      replyResult: { text: "cap", mediaUrl: "http://example.com/a.ogg" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        audio: expect.any(Buffer),
        ptt: true,
        mimetype: "audio/ogg",
        caption: "cap",
      }),
    );
  });

  it("sends video media", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("vid"),
      contentType: "video/mp4",
      kind: "video",
    });

    await deliverWebReply({
      replyResult: { text: "cap", mediaUrl: "http://example.com/v.mp4" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        video: expect.any(Buffer),
        caption: "cap",
        mimetype: "video/mp4",
      }),
    );
  });

  it("sends non-audio/image/video media as document", async () => {
    const msg = makeMsg();
    (
      loadWebMedia as unknown as { mockResolvedValueOnce: (v: unknown) => void }
    ).mockResolvedValueOnce({
      buffer: Buffer.from("bin"),
      contentType: undefined,
      kind: "file",
      fileName: "x.bin",
    });

    await deliverWebReply({
      replyResult: { text: "cap", mediaUrl: "http://example.com/x.bin" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.sendMedia).toHaveBeenCalledWith(
      expect.objectContaining({
        document: expect.any(Buffer),
        fileName: "x.bin",
        caption: "cap",
        mimetype: "application/octet-stream",
      }),
    );
  });

  it("times out a hung trailing text send after media delivery", async () => {
    vi.useFakeTimers();
    try {
      const msg = makeMsg();
      mockLoadedImageMedia();
      (
        msg.reply as unknown as { mockImplementationOnce: (fn: () => Promise<void>) => void }
      ).mockImplementationOnce(() => createNeverSettlingPromise<void>());

      const deliveryPromise = deliverWebReply({
        replyResult: { text: "aaaaaa", mediaUrl: "http://example.com/img.jpg" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 3,
        replyLogger,
        timeoutMs: 25,
        skipLog: true,
      });
      const deliveryExpectation = expect(deliveryPromise).rejects.toThrow(
        "delivery timed out after 25ms",
      );

      await vi.advanceTimersByTimeAsync(25);
      await deliveryExpectation;
      expect(msg.sendMedia).toHaveBeenCalledTimes(1);
      expect(msg.reply).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
