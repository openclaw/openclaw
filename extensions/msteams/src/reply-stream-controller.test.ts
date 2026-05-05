import { describe, expect, it, vi } from "vitest";
import { createTeamsReplyStreamController } from "./reply-stream-controller.js";

function makeStream() {
  return {
    emit: vi.fn(),
    update: vi.fn(),
    close: vi.fn(async () => undefined),
    canceled: false,
  };
}

function makeContext(stream?: ReturnType<typeof makeStream>) {
  return { activity: { type: "message" }, stream } as never;
}

function makeController(
  opts: { conversationType?: string; stream?: ReturnType<typeof makeStream> } = {},
) {
  const stream = opts.stream;
  return createTeamsReplyStreamController({
    conversationType: opts.conversationType ?? "personal",
    context: makeContext(stream),
    feedbackLoopEnabled: false,
  });
}

describe("createTeamsReplyStreamController", () => {
  it("emits chunks via stream.emit when tokens arrive", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "hello" });
    expect(stream.emit).toHaveBeenCalledWith("hello");
  });

  it("sends informative update once on first onReplyStart", async () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    await ctrl.onReplyStart();
    await ctrl.onReplyStart();
    expect(stream.update).toHaveBeenCalledTimes(1);
  });

  it("suppresses block delivery when text was streamed", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "streamed" });
    expect(ctrl.preparePayload({ text: "streamed" })).toBeUndefined();
  });

  it("strips text but keeps media when text was streamed and payload has media", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "streamed" });
    expect(ctrl.preparePayload({ text: "streamed", mediaUrl: "https://x/y.png" })).toEqual({
      text: undefined,
      mediaUrl: "https://x/y.png",
    });
  });

  it("drops the payload after the stream is canceled (e.g. user Stop)", () => {
    // After the user presses Stop in Teams, the streamed prefix is already
    // visible. Returning the full payload here would render as a SECOND
    // message containing everything — defeating the cancel intent.
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "partial" });
    stream.canceled = true;
    expect(ctrl.preparePayload({ text: "partial complete" })).toBeUndefined();
  });

  it("drops the payload even when it carries media after cancel", () => {
    // Cancel honored consistently — no leftover media bubble lands either.
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "partial" });
    stream.canceled = true;
    expect(
      ctrl.preparePayload({ text: "partial complete", mediaUrl: "https://x/y.png" }),
    ).toBeUndefined();
  });

  it("falls back to block delivery when no tokens were streamed", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    expect(ctrl.preparePayload({ text: "tool-only response" })).toEqual({
      text: "tool-only response",
    });
  });

  it("closes the stream in finalize when tokens were emitted", async () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "streamed" });
    await ctrl.finalize();
    expect(stream.close).toHaveBeenCalled();
  });

  it("does not close the stream in finalize when no tokens were emitted", async () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    await ctrl.finalize();
    expect(stream.close).not.toHaveBeenCalled();
  });

  it("does not close a canceled stream in finalize", async () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "partial" });
    stream.canceled = true;
    await ctrl.finalize();
    expect(stream.close).not.toHaveBeenCalled();
  });

  describe("StreamCancelledError handling", () => {
    function makeCancelError(): Error {
      const err = new Error("stream canceled");
      err.name = "StreamCancelledError";
      return err;
    }

    it("swallows StreamCancelledError thrown from stream.emit (Stop button race)", () => {
      const stream = makeStream();
      stream.emit.mockImplementation(() => {
        throw makeCancelError();
      });
      const ctrl = makeController({ stream });
      // Must not throw — the SDK throws this synchronously when _canceled
      // flipped between our pre-check and the emit call (or when no pre-check
      // happens at all). An uncaught throw here crashes the gateway process
      // since it surfaces as an unhandled promise rejection in async paths.
      expect(() => ctrl.onPartialReply({ text: "after stop" })).not.toThrow();
    });

    it("swallows StreamCancelledError thrown from stream.update on first onReplyStart", async () => {
      const stream = makeStream();
      stream.update.mockImplementation(() => {
        throw makeCancelError();
      });
      const ctrl = makeController({ stream });
      await expect(ctrl.onReplyStart()).resolves.toBeUndefined();
    });

    it("swallows StreamCancelledError thrown from stream.emit during finalize", async () => {
      const stream = makeStream();
      const ctrl = makeController({ stream });
      ctrl.onPartialReply({ text: "partial" });
      // Cancel after we've started streaming, then make the final emit throw.
      stream.emit.mockImplementation(() => {
        throw makeCancelError();
      });
      // Must not throw — finalize's pre-check on stream.canceled may miss
      // the cancellation that happens between check and emit.
      await expect(ctrl.finalize()).resolves.toBeUndefined();
    });

    it("re-throws non-cancel errors from stream.emit", () => {
      const stream = makeStream();
      stream.emit.mockImplementation(() => {
        throw new Error("network failure");
      });
      const ctrl = makeController({ stream });
      expect(() => ctrl.onPartialReply({ text: "boom" })).toThrow("network failure");
    });

    it("treats post-cancel stream as inactive without further emit attempts", () => {
      const stream = makeStream();
      stream.emit.mockImplementationOnce(() => {
        throw makeCancelError();
      });
      const ctrl = makeController({ stream });
      ctrl.onPartialReply({ text: "first chunk after stop" });
      // Subsequent partial replies should short-circuit and not call emit
      // again (the SDK would throw on every call once canceled).
      ctrl.onPartialReply({ text: "second chunk" });
      ctrl.onPartialReply({ text: "third chunk" });
      expect(stream.emit).toHaveBeenCalledTimes(1);
      expect(ctrl.isStreamActive()).toBe(false);
    });
  });

  describe("non-personal conversation", () => {
    it("does not stream in channels — onPartialReply is a no-op", () => {
      const stream = makeStream();
      const ctrl = makeController({ conversationType: "channel", stream });
      ctrl.onPartialReply({ text: "anything" });
      expect(stream.emit).not.toHaveBeenCalled();
    });

    it("hasStream returns false for channels", () => {
      const ctrl = makeController({ conversationType: "channel", stream: makeStream() });
      expect(ctrl.hasStream()).toBe(false);
    });

    it("preparePayload returns payload unchanged for channels", () => {
      const ctrl = makeController({ conversationType: "channel", stream: makeStream() });
      expect(ctrl.preparePayload({ text: "hi" })).toEqual({ text: "hi" });
    });
  });

  describe("isStreamActive", () => {
    it("returns false before any tokens arrive", () => {
      expect(makeController({ stream: makeStream() }).isStreamActive()).toBe(false);
    });

    it("returns true while receiving tokens", () => {
      const ctrl = makeController({ stream: makeStream() });
      ctrl.onPartialReply({ text: "tokens" });
      expect(ctrl.isStreamActive()).toBe(true);
    });

    it("returns false when stream is canceled", () => {
      const stream = makeStream();
      const ctrl = makeController({ stream });
      ctrl.onPartialReply({ text: "tokens" });
      stream.canceled = true;
      expect(ctrl.isStreamActive()).toBe(false);
    });

    it("returns false for non-personal conversations", () => {
      const ctrl = makeController({ conversationType: "channel", stream: makeStream() });
      ctrl.onPartialReply({ text: "tokens" });
      expect(ctrl.isStreamActive()).toBe(false);
    });
  });
});
