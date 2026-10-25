import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixDraftStream } from "./draft-stream.js";
import type { MatrixClient } from "./sdk.js";

const sendModuleMocks = vi.hoisted(() => {
  // send.test.ts owns wire encoding; this suite observes draft lifecycle dispatches.
  const dispatch = vi.fn<(...args: unknown[]) => Promise<string>>();
  const resolveTextChunkLimitMock = vi.fn<
    (cfg: unknown, channel: unknown, accountId?: unknown) => number
  >(() => 4000);
  const convertMarkdownTablesMock = vi.fn((text: string) => text);
  const prepareMatrixSingleText = vi.fn(
    (trimmedText: string, opts: { cfg?: unknown; accountId?: string } = {}) => {
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
    async (...args: Parameters<typeof import("./send.js").sendSingleTextMessageMatrix>) => ({
      messageId: await dispatch(...args),
    }),
  );
  const editMessageMatrix = vi.fn(
    async (...args: Parameters<typeof import("./send.js").editMessageMatrix>) =>
      await dispatch(...args),
  );
  return {
    dispatch,
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
const sendMessageMock = sendModuleMocks.dispatch;

function expectLogContaining(log: ReturnType<typeof vi.fn>, fragment: string): void {
  expect(log.mock.calls.map((call) => String(call[0])).join("\n")).toContain(fragment);
}

async function update(stream: ReturnType<typeof createMatrixDraftStream>, text: string) {
  stream.update(text);
  await stream.flush();
}

describe("createMatrixDraftStream", () => {
  let client: MatrixClient;

  function createStream(options: Partial<Parameters<typeof createMatrixDraftStream>[0]> = {}) {
    return createMatrixDraftStream({ roomId: "!room:test", client, cfg: {}, ...options });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    sendMessageMock.mockReset().mockResolvedValue("$evt1");
    client = { sendMessage: sendMessageMock } as unknown as MatrixClient;
    resolveTextChunkLimitMock.mockReset().mockReturnValue(4000);
    convertMarkdownTablesMock.mockReset().mockImplementation((text: string) => text);
    sendModuleMocks.editMessageMatrix.mockClear();
    sendModuleMocks.sendSingleTextMessageMatrix.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves indented code through draft sends, edits, and final comparisons", async () => {
    const stream = createStream();
    const firstMarkdown = "    @room";

    await update(stream, `${firstMarkdown}  `);

    expect(sendModuleMocks.sendSingleTextMessageMatrix.mock.calls[0]?.[1]).toBe(firstMarkdown);
    expect(sendModuleMocks.sendSingleTextMessageMatrix.mock.calls[0]?.[2]).toMatchObject({
      client,
      cfg: {},
      includeMentions: false,
      live: true,
      msgtype: "m.text",
    });
    expect(stream.content()).toBe(firstMarkdown);
    expect(stream.matchesPreparedText(`${firstMarkdown}  `)).toBe(true);
    expect(stream.matchesPreparedText("@room")).toBe(false);

    vi.advanceTimersByTime(1000);
    const editedMarkdown = "    @alice:example.org";
    await update(stream, editedMarkdown);

    expect(sendModuleMocks.editMessageMatrix.mock.lastCall?.[2]).toBe(editedMarkdown);
    expect(stream.content()).toBe(editedMarkdown);
  });

  it("coalesces rapid quiet updates within throttle window", async () => {
    const stream = createStream({ mode: "quiet" });

    stream.update("A");
    stream.update("AB");
    await update(stream, "ABC");

    // The first send is immediate; the remaining updates coalesce into one edit.
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(sendModuleMocks.sendSingleTextMessageMatrix).toHaveBeenCalledWith(
      "!room:test",
      "A",
      expect.objectContaining({ msgtype: "m.notice", live: false }),
    );
    expect(sendModuleMocks.editMessageMatrix).toHaveBeenCalledWith(
      "!room:test",
      "$evt1",
      "ABC",
      expect.objectContaining({ msgtype: "m.notice", live: false }),
    );
  });

  it("skips no-op updates", async () => {
    const stream = createStream();

    await update(stream, "Hello");
    const callCount = sendMessageMock.mock.calls.length;

    vi.advanceTimersByTime(1000);

    await update(stream, "Hello");
    expect(sendMessageMock).toHaveBeenCalledTimes(callCount);
  });

  it.each([false, true])("finalizes live previews (failure=%s)", async (failure) => {
    if (failure) {
      sendMessageMock
        .mockResolvedValueOnce("$evt1")
        .mockRejectedValueOnce(new Error("rate limited"));
    }
    const stream = createStream({ mode: "partial" });
    stream.update("Hello");
    expect(await stream.stop()).toBe("$evt1");
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendModuleMocks.sendSingleTextMessageMatrix.mock.calls[0]?.[2]?.live).toBe(true);
    if (failure) {
      await expect(stream.finalizeLive()).resolves.toBe(false);
      expect(stream.mustDeliverFinalNormally()).toBe(true);
    } else {
      await stream.finalizeLive();
      await stream.finalizeLive();
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(sendModuleMocks.editMessageMatrix.mock.lastCall?.[3]?.live).toBe(false);
    }
  });

  it("reset allows reuse for next block", async () => {
    sendMessageMock.mockResolvedValueOnce("$first").mockResolvedValueOnce("$second");

    const stream = createStream({ mode: "quiet" });

    stream.update("Block 1");
    await stream.stop();
    expect(stream.eventId()).toBe("$first");

    stream.reset();
    expect(stream.eventId()).toBeUndefined();

    stream.update("Block 2");
    await stream.stop();
    expect(stream.eventId()).toBe("$second");
  });

  it.each([false, true])("stops retrying after send/edit failure (editing=%s)", async (editing) => {
    const log = vi.fn();
    const stream = createStream({ log });
    if (editing) {
      await update(stream, "Hello");
      expect(stream.eventId()).toBe("$evt1");
      vi.advanceTimersByTime(1000);
    }
    sendMessageMock.mockRejectedValueOnce(new Error(editing ? "rate limited" : "network error"));
    await update(stream, editing ? "Hello world" : "Hello");
    expectLogContaining(log, "send/edit failed");
    vi.advanceTimersByTime(1000);
    await update(stream, "More text");
    expect(sendMessageMock).toHaveBeenCalledTimes(editing ? 2 : 1);
    if (!editing) {
      expect(stream.eventId()).toBeUndefined();
    }
  });

  it("discardPending cancels pending updates without creating another preview event", async () => {
    const stream = createStream();

    await update(stream, "First draft");
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
    const stream = createStream({ log });

    await update(stream, "1234");

    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(stream.eventId()).toBeUndefined();
    expectLogContaining(log, "preview exceeded single-event limit");
  });
});
