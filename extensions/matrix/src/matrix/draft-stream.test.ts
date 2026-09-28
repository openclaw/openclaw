// Matrix tests cover draft stream plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixDraftStream } from "./draft-stream.js";

const sendModuleMocks = vi.hoisted(() => {
  const resolveTextChunkLimitMock = vi.fn<
    (cfg: unknown, channel: unknown, accountId?: unknown) => number
  >(() => 4000);
  const convertMarkdownTablesMock = vi.fn((text: string) => text);
  const prepareMatrixSingleText = vi.fn(
    (
      text: string,
      opts: { cfg?: unknown; accountId?: string; preserveWhitespace?: boolean } = {},
    ) => {
      const trimmedText = opts.preserveWhitespace ? text : text.trim();
      const convertedText = convertMarkdownTablesMock(trimmedText);
      const singleEventLimit = Math.min(
        resolveTextChunkLimitMock(opts.cfg ?? {}, "matrix", opts.accountId),
        4000,
      );
      return {
        trimmedText,
        convertedText,
        singleEventLimit,
        fitsInSingleEvent: convertedText.length <= singleEventLimit,
      };
    },
  );
  const sendSingleTextMessageMatrix = vi.fn(
    async (
      roomId: string,
      text: string,
      opts: {
        client?: {
          sendMessage: (roomId: string, content: Record<string, unknown>) => Promise<string>;
        };
        cfg?: unknown;
        accountId?: string;
        msgtype?: string;
        includeMentions?: boolean;
        live?: boolean;
      } = {},
    ) => {
      const prepared = prepareMatrixSingleText(text, {
        cfg: opts.cfg,
        accountId: opts.accountId,
        preserveWhitespace: true,
      });
      if (!prepared.trimmedText) {
        throw new Error("Matrix single-message send requires text");
      }
      if (!prepared.fitsInSingleEvent) {
        throw new Error("Matrix single-message text exceeds limit");
      }
      const content: Record<string, unknown> = {
        msgtype: opts.msgtype ?? "m.text",
        body: prepared.convertedText,
      };
      if (opts.live) {
        content["org.matrix.msc4357.live"] = {};
      }
      const eventId = await opts.client?.sendMessage(roomId, content);
      return {
        messageId: eventId ?? "unknown",
        roomId,
        primaryMessageId: eventId ?? "unknown",
        receipt: {
          ...(eventId ? { primaryPlatformMessageId: eventId } : {}),
          platformMessageIds: eventId ? [eventId] : [],
          parts: eventId ? [{ platformMessageId: eventId, kind: "text" as const, index: 0 }] : [],
          sentAt: 123,
        },
      };
    },
  );
  const editMessageMatrix = vi.fn(
    async (
      roomId: string,
      originalEventId: string,
      newText: string,
      opts: {
        client?: {
          sendMessage: (roomId: string, content: Record<string, unknown>) => Promise<string>;
        };
        msgtype?: string;
        live?: boolean;
      } = {},
    ) => {
      const convertedText = convertMarkdownTablesMock(newText);
      const newContent: Record<string, unknown> = {
        msgtype: opts.msgtype ?? "m.text",
        body: convertedText,
      };
      if (opts.live) {
        newContent["org.matrix.msc4357.live"] = {};
      }
      const content: Record<string, unknown> = {
        ...newContent,
        body: `* ${convertedText}`,
        "m.new_content": newContent,
        "m.relates_to": {
          rel_type: "m.replace",
          event_id: originalEventId,
        },
      };
      if (opts.live) {
        content["org.matrix.msc4357.live"] = {};
      }
      return (await opts.client?.sendMessage(roomId, content)) ?? "";
    },
  );
  return {
    convertMarkdownTablesMock,
    editMessageMatrix,
    prepareMatrixSingleText,
    resolveTextChunkLimitMock,
    sendSingleTextMessageMatrix,
  };
});

const { convertMarkdownTablesMock, resolveTextChunkLimitMock } = sendModuleMocks;

vi.mock("./send.js", () => ({
  editMessageMatrix: sendModuleMocks.editMessageMatrix,
  prepareMatrixSingleText: sendModuleMocks.prepareMatrixSingleText,
  sendSingleTextMessageMatrix: sendModuleMocks.sendSingleTextMessageMatrix,
}));
const sendMessageMock = vi.fn();

function createMockClient() {
  sendMessageMock.mockReset().mockResolvedValue("$evt1");
  return {
    sendMessage: sendMessageMock,
  } as unknown as import("./sdk.js").MatrixClient;
}

function sentContentAt(callIndex: number): Record<string, unknown> {
  const content = sendMessageMock.mock.calls[callIndex]?.[1];
  if (!content || typeof content !== "object") {
    throw new Error(`Expected sent content at call ${callIndex}`);
  }
  return content as Record<string, unknown>;
}

function expectLogContaining(log: ReturnType<typeof vi.fn>, fragment: string): void {
  expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain(fragment);
}

describe("createMatrixDraftStream", () => {
  let client: ReturnType<typeof createMockClient>;

  function createStream(options: Partial<Parameters<typeof createMatrixDraftStream>[0]> = {}) {
    return createMatrixDraftStream({ roomId: "!room:test", client, cfg: {}, ...options });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    client = createMockClient();
    resolveTextChunkLimitMock.mockReset().mockReturnValue(4000);
    convertMarkdownTablesMock.mockReset().mockImplementation((text: string) => text);
    sendModuleMocks.editMessageMatrix.mockClear();
    sendModuleMocks.sendSingleTextMessageMatrix.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends a normal text preview on first partial update", async () => {
    const stream = createStream();

    stream.update("Hello");
    await stream.flush();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sentContentAt(0).msgtype).toBe("m.text");
    expect(sendModuleMocks.sendSingleTextMessageMatrix.mock.calls[0]?.[2]).toMatchObject({
      includeMentions: false,
      live: true,
      msgtype: "m.text",
    });
    expect(stream.eventId()).toBe("$evt1");
  });

  it("tracks the provider-visible prepared draft content", async () => {
    convertMarkdownTablesMock.mockImplementation((text: string) => `prepared:${text}`);
    const stream = createStream();

    stream.update("raw table");
    await stream.flush();

    expect(stream.content()).toBe("prepared:raw table");
  });

  it("preserves indented code through draft sends, edits, and final comparisons", async () => {
    const stream = createStream();
    const firstMarkdown = "    @room";

    stream.update(`${firstMarkdown}  `);
    await stream.flush();

    expect(sentContentAt(0).body).toBe(firstMarkdown);
    expect(stream.content()).toBe(firstMarkdown);
    expect(stream.matchesPreparedText(`${firstMarkdown}  `)).toBe(true);
    expect(stream.matchesPreparedText("@room")).toBe(false);

    vi.advanceTimersByTime(1000);
    const editedMarkdown = "    @alice:example.org";
    stream.update(editedMarkdown);
    await stream.flush();

    expect(sendModuleMocks.editMessageMatrix.mock.lastCall?.[2]).toBe(editedMarkdown);
    expect(stream.content()).toBe(editedMarkdown);
  });

  it("coalesces rapid quiet updates within throttle window", async () => {
    const stream = createStream({
      mode: "quiet",
    });

    stream.update("A");
    stream.update("AB");
    stream.update("ABC");
    await stream.flush();

    // First update fires immediately (fresh throttle window), then AB/ABC
    // coalesce into a single edit with the latest text.
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sentContentAt(0).body).toBe("A");
    // Edit uses "* <text>" prefix per Matrix m.replace spec.
    expect(sentContentAt(1).body).toBe("* ABC");
    expect(sentContentAt(0).msgtype).toBe("m.notice");
    expect(sentContentAt(1).msgtype).toBe("m.notice");
    expect(sentContentAt(1)["m.new_content"]).toEqual({ msgtype: "m.notice", body: "ABC" });
  });

  it("skips no-op updates", async () => {
    const stream = createStream();

    stream.update("Hello");
    await stream.flush();
    const callCount = sendMessageMock.mock.calls.length;

    vi.advanceTimersByTime(1000);

    // Same text again — should not send
    stream.update("Hello");
    await stream.flush();
    expect(sendMessageMock).toHaveBeenCalledTimes(callCount);
  });

  it("ignores updates after stop", async () => {
    const stream = createStream();

    stream.update("Hello");
    await stream.stop();
    const callCount = sendMessageMock.mock.calls.length;

    stream.update("Ignored");
    await stream.flush();
    expect(sendMessageMock).toHaveBeenCalledTimes(callCount);
  });

  it("stop returns the event ID", async () => {
    const stream = createStream();

    stream.update("Hello");
    const eventId = await stream.stop();
    expect(eventId).toBe("$evt1");
  });

  it("stop does not finalize live drafts on its own", async () => {
    const stream = createStream({
      mode: "partial",
    });

    stream.update("Hello");
    await stream.stop();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls.at(0)?.[1]).toHaveProperty("org.matrix.msc4357.live");
  });

  it("finalizeLive clears the live marker at most once", async () => {
    const stream = createStream({
      mode: "partial",
    });

    stream.update("Hello");
    await stream.stop();

    await stream.finalizeLive();
    await stream.finalizeLive();

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendMessageMock.mock.calls.at(1)?.[1]).not.toHaveProperty("org.matrix.msc4357.live");
  });

  it("marks live finalize failures for normal final delivery fallback", async () => {
    sendMessageMock.mockResolvedValueOnce("$evt1").mockRejectedValueOnce(new Error("rate limited"));

    const stream = createStream({
      mode: "partial",
    });

    stream.update("Hello");
    await stream.stop();

    await expect(stream.finalizeLive()).resolves.toBe(false);
    expect(stream.mustDeliverFinalNormally()).toBe(true);
  });

  it("reset allows reuse for next block", async () => {
    sendMessageMock.mockResolvedValueOnce("$first").mockResolvedValueOnce("$second");

    const stream = createStream({
      mode: "quiet",
    });

    stream.update("Block 1");
    await stream.stop();
    expect(stream.eventId()).toBe("$first");

    stream.reset();
    expect(stream.eventId()).toBeUndefined();

    stream.update("Block 2");
    await stream.stop();
    expect(stream.eventId()).toBe("$second");
  });

  it("stops retrying after send failure", async () => {
    sendMessageMock.mockRejectedValueOnce(new Error("network error"));

    const log = vi.fn();
    const stream = createStream({
      log,
    });

    stream.update("Hello");
    await stream.flush();

    // Should have logged the failure
    expectLogContaining(log, "send/edit failed");

    vi.advanceTimersByTime(1000);

    // Further updates should not attempt sends (stream is stopped)
    stream.update("More text");
    await stream.flush();

    // Only the initial failed attempt
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(stream.eventId()).toBeUndefined();
  });

  it("skips empty/whitespace text", async () => {
    const stream = createStream();

    stream.update("   ");
    await stream.flush();

    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  it("stops on edit failure mid-stream", async () => {
    sendMessageMock
      .mockResolvedValueOnce("$evt1") // initial send succeeds
      .mockRejectedValueOnce(new Error("rate limited")); // edit fails

    const log = vi.fn();
    const stream = createStream({
      log,
    });

    stream.update("Hello");
    await stream.flush();
    expect(stream.eventId()).toBe("$evt1");

    vi.advanceTimersByTime(1000);

    stream.update("Hello world");
    await stream.flush();
    expectLogContaining(log, "send/edit failed");

    vi.advanceTimersByTime(1000);

    // Stream should be stopped — further updates are ignored
    stream.update("More text");
    await stream.flush();
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
  });

  it("discardPending cancels pending updates without creating another preview event", async () => {
    const stream = createStream();

    stream.update("First draft");
    await stream.flush();
    stream.update("Pending draft");
    await stream.discardPending();
    await stream.flush();

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendModuleMocks.editMessageMatrix).not.toHaveBeenCalled();
    expect(stream.eventId()).toBe("$evt1");
  });

  it("uses converted Matrix text when checking the single-event preview limit", async () => {
    const log = vi.fn();
    resolveTextChunkLimitMock.mockReturnValue(5);
    convertMarkdownTablesMock.mockImplementation(() => "123456");
    const stream = createStream({
      log,
    });

    stream.update("1234");
    await stream.flush();

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(stream.eventId()).toBeUndefined();
    expectLogContaining(log, "preview exceeded single-event limit");
  });
});
