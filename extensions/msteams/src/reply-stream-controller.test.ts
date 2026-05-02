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

  it("falls back to block delivery when stream was canceled by Teams", () => {
    const stream = makeStream();
    const ctrl = makeController({ stream });
    ctrl.onPartialReply({ text: "partial" });
    stream.canceled = true;
    expect(ctrl.preparePayload({ text: "partial complete" })).toEqual({
      text: "partial complete",
    });
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
