import { beforeEach, describe, expect, it, vi } from "vitest";
import { logVerbose } from "../../../../src/globals.js";
import { loadWebMedia } from "../media.js";
import { deliverWebReply } from "./deliver-reply.js";
import type { WebInboundMsg } from "./types.js";

const { sleepWithAbortMock } = vi.hoisted(() => ({
  sleepWithAbortMock: vi.fn(async (_ms: number, _signal?: AbortSignal) => undefined),
}));

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

vi.mock("../reconnect.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../reconnect.js")>();
  return {
    ...actual,
    sleepWithAbort: (ms: number, signal?: AbortSignal) => sleepWithAbortMock(ms, signal),
  };
});

function makeMsg(): WebInboundMsg {
  return {
    from: "+10000000000",
    to: "+20000000000",
    id: "msg-1",
    reply: vi.fn(async () => undefined),
    sendMedia: vi.fn(async () => undefined),
    shouldRetryDisconnect: () => true,
    disconnectRetryWindowActive: () => false,
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
  beforeEach(() => {
    vi.clearAllMocks();
    sleepWithAbortMock.mockImplementation(async () => undefined);
  });

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
      expect(sleepWithAbortMock).toHaveBeenCalledWith(500, undefined);
    },
  );

  it("escalates to extended retries for reconnect-gap errors", async () => {
    const msg = makeMsg();
    (msg.reply as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(
      new Error("no active socket - reconnection in progress"),
    );
    (msg.reply as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(
      new Error("socket closed"),
    );
    (msg.reply as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(
      new Error("socket closed"),
    );
    (msg.reply as unknown as { mockRejectedValueOnce: (v: unknown) => void }).mockRejectedValueOnce(
      new Error("socket closed"),
    );
    (msg.reply as unknown as { mockResolvedValueOnce: (v: unknown) => void }).mockResolvedValueOnce(
      undefined,
    );

    await deliverWebReply({
      replyResult: { text: "hi" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 200,
      replyLogger,
      skipLog: true,
    });

    expect(msg.reply).toHaveBeenCalledTimes(5);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(1, 500, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(2, 2000, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(3, 3600, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(4, 6480, undefined);
  });

  it("caps retries after extended disconnect budget", async () => {
    const msg = makeMsg();
    msg.disconnectRetryWindowActive = () => true;
    (msg.reply as unknown as { mockRejectedValue: (v: unknown) => void }).mockRejectedValue(
      new Error("socket disconnected"),
    );

    await expect(
      deliverWebReply({
        replyResult: { text: "hi" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        skipLog: true,
      }),
    ).rejects.toThrow("socket disconnected");

    expect(msg.reply).toHaveBeenCalledTimes(14);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(13);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(1, 500, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(2, 2000, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(3, 3600, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(4, 6480, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(5, 11664, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(6, 20995, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(7, 30000, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(13, 30000, undefined);
  });

  it("does not retry disconnect errors when reconnect is not expected", async () => {
    const msg = makeMsg();
    msg.shouldRetryDisconnect = () => false;
    (msg.reply as unknown as { mockRejectedValue: (v: unknown) => void }).mockRejectedValue(
      new Error("no active socket - reconnection in progress"),
    );

    await expect(
      deliverWebReply({
        replyResult: { text: "hi" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        skipLog: true,
      }),
    ).rejects.toThrow("no active socket - reconnection in progress");

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).not.toHaveBeenCalled();
  });

  it("extends disconnect retries for the full reconnect loop", async () => {
    const msg = makeMsg();
    msg.disconnectRetryWindowActive = () => true;
    msg.disconnectRetryPolicy = {
      initialMs: 5_000,
      maxMs: 60_000,
      factor: 2,
      jitter: 0,
      maxAttempts: 6,
    };
    (msg.reply as unknown as { mockRejectedValue: (v: unknown) => void }).mockRejectedValue(
      new Error("socket disconnected"),
    );

    await expect(
      deliverWebReply({
        replyResult: { text: "hi" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        skipLog: true,
      }),
    ).rejects.toThrow("socket disconnected");

    expect(msg.reply).toHaveBeenCalledTimes(7);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(6);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(1, 500, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(2, 5000, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(3, 10000, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(4, 20000, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(5, 40000, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(6, 60000, undefined);
  });

  it("keeps generic timeout errors on the standard retry window outside reconnect gaps", async () => {
    const msg = makeMsg();
    (msg.reply as unknown as { mockRejectedValue: (v: unknown) => void }).mockRejectedValue(
      new Error("operation timed out"),
    );

    await expect(
      deliverWebReply({
        replyResult: { text: "hi" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        skipLog: true,
      }),
    ).rejects.toThrow("operation timed out");

    expect(msg.reply).toHaveBeenCalledTimes(3);
    expect(sleepWithAbortMock).toHaveBeenCalledTimes(2);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(1, 500, undefined);
    expect(sleepWithAbortMock).toHaveBeenNthCalledWith(2, 1000, undefined);
  });

  it("aborts reconnect-gap backoff when shutdown begins", async () => {
    const msg = makeMsg();
    const controller = new AbortController();
    msg.disconnectRetryAbortSignal = controller.signal;
    msg.shouldRetryDisconnect = () => !controller.signal.aborted;
    (msg.reply as unknown as { mockRejectedValue: (v: unknown) => void }).mockRejectedValue(
      new Error("no active socket - reconnection in progress"),
    );
    sleepWithAbortMock.mockImplementationOnce(async () => {
      controller.abort();
      throw new Error("aborted");
    });

    await expect(
      deliverWebReply({
        replyResult: { text: "hi" },
        msg,
        maxMediaBytes: 1024 * 1024,
        textLimit: 200,
        replyLogger,
        skipLog: true,
      }),
    ).rejects.toThrow("no active socket - reconnection in progress");

    expect(msg.reply).toHaveBeenCalledTimes(1);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(500, controller.signal);
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
    expect(sleepWithAbortMock).toHaveBeenCalledWith(500, undefined);
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

  it("retries fallback text when reconnect gap happens after media failure", async () => {
    const msg = makeMsg();
    mockLoadedImageMedia();
    mockFirstSendMediaFailure(msg, "boom");
    mockFirstReplyFailure(msg, "no active socket - reconnection in progress");
    mockSecondReplySuccess(msg);

    await deliverWebReply({
      replyResult: { text: "caption", mediaUrl: "http://example.com/img.jpg" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 20,
      replyLogger,
      skipLog: true,
    });

    expect(msg.reply).toHaveBeenCalledTimes(2);
    expect(sleepWithAbortMock).toHaveBeenCalledWith(500, undefined);
  });

  it("retries remaining text chunks after media when reconnect gap happens", async () => {
    const msg = makeMsg();
    msg.disconnectRetryWindowActive = () => true;
    mockLoadedImageMedia();
    mockFirstReplyFailure(msg, "socket closed");
    mockSecondReplySuccess(msg);

    await deliverWebReply({
      replyResult: { text: "aaaaaa", mediaUrl: "http://example.com/img.jpg" },
      msg,
      maxMediaBytes: 1024 * 1024,
      textLimit: 3,
      replyLogger,
      skipLog: true,
    });

    expect(msg.sendMedia).toHaveBeenCalledTimes(1);
    expect(msg.reply).toHaveBeenCalledTimes(2);
    expect(msg.reply).toHaveBeenNthCalledWith(1, "aaa");
    expect(msg.reply).toHaveBeenNthCalledWith(2, "aaa");
    expect(sleepWithAbortMock).toHaveBeenCalledWith(500, undefined);
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
});
