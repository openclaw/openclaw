import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMatrixDraftStream } from "./draft-stream.js";
import type { MatrixSendResult } from "./send.js";

const ROOM_ID = "!room:example";
const CURSOR = " \u258c";

function makeMocks() {
  const _send = vi
    .fn<
      (to: string, message: string, opts?: Record<string, unknown>) => Promise<MatrixSendResult>
    >()
    .mockResolvedValue({ messageId: "evt-initial", roomId: ROOM_ID });

  const _edit = vi
    .fn<
      (
        roomId: string,
        eventId: string,
        text: string,
        opts?: Record<string, unknown>,
      ) => Promise<MatrixSendResult>
    >()
    .mockResolvedValue({ messageId: "evt-edit-1", roomId: ROOM_ID });

  return { _send, _edit };
}

describe("createMatrixDraftStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("update() sends initial message with cursor on first call", async () => {
    const { _send, _edit } = makeMocks();
    const throttleMs = 800;
    const stream = createMatrixDraftStream({
      roomId: ROOM_ID,
      throttleMs,
      _send,
      _edit,
    });

    stream.update("hello");
    await vi.advanceTimersByTimeAsync(throttleMs);

    expect(_send).toHaveBeenCalledOnce();
    const [, text] = _send.mock.calls[0] as [string, string];
    expect(text).toBe(`hello${CURSOR}`);
    expect(_edit).not.toHaveBeenCalled();
  });

  it("update() edits existing event on subsequent calls", async () => {
    const { _send, _edit } = makeMocks();
    const throttleMs = 800;
    const stream = createMatrixDraftStream({
      roomId: ROOM_ID,
      throttleMs,
      _send,
      _edit,
    });

    stream.update("hello");
    await vi.advanceTimersByTimeAsync(throttleMs);
    // Wait for the send to complete
    await vi.runAllTimersAsync();

    stream.update("hello world");
    await vi.advanceTimersByTimeAsync(throttleMs);
    await vi.runAllTimersAsync();

    expect(_send).toHaveBeenCalledOnce();
    expect(_edit).toHaveBeenCalledOnce();
    const [, eventId, text] = _edit.mock.calls[0] as [string, string, string];
    expect(eventId).toBe("evt-initial");
    expect(text).toBe(`hello world${CURSOR}`);
  });

  it("update() skips edit when text has not changed", async () => {
    const { _send, _edit } = makeMocks();
    const throttleMs = 800;
    const stream = createMatrixDraftStream({
      roomId: ROOM_ID,
      throttleMs,
      _send,
      _edit,
    });

    stream.update("same text");
    await vi.advanceTimersByTimeAsync(throttleMs);
    await vi.runAllTimersAsync();

    stream.update("same text");
    await vi.advanceTimersByTimeAsync(throttleMs);
    await vi.runAllTimersAsync();

    // Only the first call should trigger a send; second is a no-op (same text)
    expect(_send).toHaveBeenCalledOnce();
    expect(_edit).not.toHaveBeenCalled();
  });

  it("finalize() sends final edit without cursor", async () => {
    const { _send, _edit } = makeMocks();
    const throttleMs = 800;
    const stream = createMatrixDraftStream({
      roomId: ROOM_ID,
      throttleMs,
      _send,
      _edit,
    });

    stream.update("partial");
    await vi.advanceTimersByTimeAsync(throttleMs);
    await vi.runAllTimersAsync();

    await stream.finalize();

    // The final edit should NOT contain the cursor
    expect(_edit).toHaveBeenCalledOnce();
    const [, , finalText] = _edit.mock.calls[0] as [string, string, string];
    expect(finalText).not.toContain(CURSOR);
    expect(finalText).toBe("partial");
  });

  it("finalize() returns eventId", async () => {
    const { _send, _edit } = makeMocks();
    const throttleMs = 800;
    const stream = createMatrixDraftStream({
      roomId: ROOM_ID,
      throttleMs,
      _send,
      _edit,
    });

    stream.update("some text");
    await vi.advanceTimersByTimeAsync(throttleMs);
    await vi.runAllTimersAsync();

    const eventId = await stream.finalize();

    expect(eventId).toBe("evt-initial");
  });

  it("finalize() is a no-op if no updates were received", async () => {
    const { _send, _edit } = makeMocks();
    const stream = createMatrixDraftStream({
      roomId: ROOM_ID,
      _send,
      _edit,
    });

    const result = await stream.finalize();

    expect(result).toBeNull();
    expect(_send).not.toHaveBeenCalled();
    expect(_edit).not.toHaveBeenCalled();
  });

  it("forceNewMessage() causes next update to send new message", async () => {
    const _send = vi
      .fn<
        (to: string, message: string, opts?: Record<string, unknown>) => Promise<MatrixSendResult>
      >()
      .mockResolvedValueOnce({ messageId: "evt-initial", roomId: ROOM_ID })
      .mockResolvedValueOnce({ messageId: "evt-second", roomId: ROOM_ID });
    const _edit = vi
      .fn<
        (
          roomId: string,
          eventId: string,
          text: string,
          opts?: Record<string, unknown>,
        ) => Promise<MatrixSendResult>
      >()
      .mockResolvedValue({ messageId: "evt-edit-1", roomId: ROOM_ID });

    const throttleMs = 800;
    const stream = createMatrixDraftStream({
      roomId: ROOM_ID,
      throttleMs,
      _send,
      _edit,
    });

    stream.update("first");
    await vi.advanceTimersByTimeAsync(throttleMs);
    await vi.runAllTimersAsync();

    stream.forceNewMessage();

    stream.update("new text");
    await vi.advanceTimersByTimeAsync(throttleMs);
    await vi.runAllTimersAsync();

    expect(_send).toHaveBeenCalledTimes(2);
    expect(_edit).not.toHaveBeenCalled();
  });

  it("throttle: rapid updates coalesce", async () => {
    const { _send, _edit } = makeMocks();
    const throttleMs = 800;
    const stream = createMatrixDraftStream({
      roomId: ROOM_ID,
      throttleMs,
      _send,
      _edit,
    });

    stream.update("a");
    stream.update("b");
    stream.update("c");
    await vi.advanceTimersByTimeAsync(throttleMs);
    await vi.runAllTimersAsync();

    // Only one API call should happen, with the last text "c ▌"
    expect(_send).toHaveBeenCalledOnce();
    expect(_edit).not.toHaveBeenCalled();
    const [, text] = _send.mock.calls[0] as [string, string];
    expect(text).toBe(`c${CURSOR}`);
  });
  it("stop() prevents further updates from firing", async () => {
    const throttleMs = 800;
    const _send = vi.fn().mockResolvedValue({ messageId: "evt-initial", roomId: ROOM_ID });
    const _edit = vi.fn().mockResolvedValue({ messageId: "evt-edit", roomId: ROOM_ID });
    const stream = createMatrixDraftStream({ roomId: ROOM_ID, throttleMs, _send, _edit });

    stream.update("hello");
    await vi.advanceTimersByTimeAsync(throttleMs);
    await vi.runAllTimersAsync();
    expect(_send).toHaveBeenCalledOnce();

    await stream.stop();
    stream.update("this should be ignored");
    await vi.advanceTimersByTimeAsync(throttleMs * 2);
    await vi.runAllTimersAsync();

    // No new send or edit after stop()
    expect(_send).toHaveBeenCalledOnce();
    expect(_edit).not.toHaveBeenCalled();
  });

  it("stop() cancels a pending timer without sending", async () => {
    const throttleMs = 800;
    const _send = vi.fn().mockResolvedValue({ messageId: "evt-initial", roomId: ROOM_ID });
    const _edit = vi.fn().mockResolvedValue({ messageId: "evt-edit", roomId: ROOM_ID });
    const stream = createMatrixDraftStream({ roomId: ROOM_ID, throttleMs, _send, _edit });

    // Queue an update but stop before the timer fires
    stream.update("pending");
    await stream.stop();
    await vi.advanceTimersByTimeAsync(throttleMs * 2);
    await vi.runAllTimersAsync();

    expect(_send).not.toHaveBeenCalled();
    expect(_edit).not.toHaveBeenCalled();
  });

  it("stop() drains an in-flight send so the caller's edit arrives last", async () => {
    // Race condition guard: if a cursor edit is in-flight when deliver fires,
    // stop() must await it so editMessageMatrix (no cursor) is sent AFTER it.
    const throttleMs = 100;
    let resolveSend!: () => void;
    const sendPromise = new Promise<void>((res) => {
      resolveSend = res;
    });
    const _send = vi
      .fn()
      .mockReturnValue(sendPromise.then(() => ({ messageId: "evt-1", roomId: ROOM_ID })));
    const _edit = vi.fn().mockResolvedValue({ messageId: "evt-edit", roomId: ROOM_ID });
    const stream = createMatrixDraftStream({ roomId: ROOM_ID, throttleMs, _send, _edit });

    // Trigger the first send (in-flight, not yet resolved)
    stream.update("partial");
    vi.advanceTimersByTime(throttleMs);
    // _send is now in-flight
    expect(_send).toHaveBeenCalledOnce();

    // stop() should wait until the in-flight send resolves
    const stopPromise = stream.stop();
    let stopResolved = false;
    void stopPromise.then(() => {
      stopResolved = true;
    });

    // stop() still pending (send has not resolved)
    await Promise.resolve();
    expect(stopResolved).toBe(false);

    // Resolve the in-flight send
    resolveSend();
    await stopPromise;
    expect(stopResolved).toBe(true);
    // Caller can now safely send the final edit — no concurrent cursor edit
  });

  it("retries update after transient send failure (lastSentText not poisoned)", async () => {
    const throttleMs = 800;
    const _send = vi
      .fn()
      .mockRejectedValueOnce(new Error("transient network error"))
      .mockResolvedValueOnce({ messageId: "evt-retry", roomId: ROOM_ID });
    const _edit = vi.fn().mockResolvedValue({ messageId: "evt-edit", roomId: ROOM_ID });
    const warn = vi.fn();
    const stream = createMatrixDraftStream({ roomId: ROOM_ID, throttleMs, _send, _edit, warn });

    // First update fails
    stream.update("hello");
    await vi.advanceTimersByTimeAsync(throttleMs);
    await vi.runAllTimersAsync();
    expect(_send).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();

    // Same text update should retry (not be deduped) because lastSentText was reset
    stream.update("hello");
    await vi.advanceTimersByTimeAsync(throttleMs);
    await vi.runAllTimersAsync();
    expect(_send).toHaveBeenCalledTimes(2);
    expect(stream.getEventId()).toBe("evt-retry");
  });
});
