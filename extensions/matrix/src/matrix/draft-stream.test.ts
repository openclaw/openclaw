import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixDraftStream } from "./draft-stream.js";
import type { MatrixClient } from "./sdk.js";

const sendModuleMocks = vi.hoisted(() => {
  type PreviewOptions = {
    client?: { sendMessage: (roomId: string, content: Record<string, unknown>) => Promise<string> };
    cfg?: unknown;
    accountId?: string;
    msgtype?: string;
    includeMentions?: boolean;
    live?: boolean;
  };
  const messageContent = (body: string, opts: PreviewOptions): Record<string, unknown> => ({
    msgtype: opts.msgtype ?? "m.text",
    body,
    ...(opts.live ? { "org.matrix.msc4357.live": {} } : {}),
  });
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
    async (roomId: string, text: string, opts: PreviewOptions = {}) => {
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
      const content = messageContent(prepared.convertedText, opts);
      const eventId = await opts.client?.sendMessage(roomId, content);
      return { messageId: eventId ?? "unknown" };
    },
  );
  const editMessageMatrix = vi.fn(
    async (roomId: string, originalEventId: string, newText: string, opts: PreviewOptions = {}) => {
      const convertedText = convertMarkdownTablesMock(newText);
      const newContent = messageContent(convertedText, opts);
      const content: Record<string, unknown> = {
        ...newContent,
        body: `* ${convertedText}`,
        "m.new_content": newContent,
        "m.relates_to": { rel_type: "m.replace", event_id: originalEventId },
      };
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

    expect(sentContentAt(0).body).toBe(firstMarkdown);
    expect(sendModuleMocks.sendSingleTextMessageMatrix.mock.calls[0]?.[2]).toMatchObject({
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
    expect(sentContentAt(0)).toMatchObject({ body: "A", msgtype: "m.notice" });
    expect(sentContentAt(1)).toMatchObject({ body: "* ABC", msgtype: "m.notice" });
    expect(sentContentAt(1)["m.new_content"]).toEqual({ msgtype: "m.notice", body: "ABC" });
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
    expect(sentContentAt(0)).toHaveProperty("org.matrix.msc4357.live");
    if (failure) {
      await expect(stream.finalizeLive()).resolves.toBe(false);
      expect(stream.mustDeliverFinalNormally()).toBe(true);
    } else {
      await stream.finalizeLive();
      await stream.finalizeLive();
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(sentContentAt(1)).not.toHaveProperty("org.matrix.msc4357.live");
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
