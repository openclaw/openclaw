import { describe, expect, it } from "vitest";
import {
  isSlackStreamingEnabled,
  resolveSlackStreamingThreadHint,
  shouldEnableSlackPreviewStreaming,
  shouldInitializeSlackDraftStream,
} from "./dispatch.js";

describe("slack native streaming defaults", () => {
  it("is enabled for partial mode when native streaming is on", () => {
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: true })).toBe(true);
  });

  it("is disabled outside partial mode or when native streaming is off", () => {
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: false })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "block", nativeStreaming: true })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "progress", nativeStreaming: true })).toBe(false);
    expect(isSlackStreamingEnabled({ mode: "off", nativeStreaming: true })).toBe(false);
  });
});

describe("slack native streaming thread hint", () => {
  it("stays off-thread when replyToMode=off and message is not in a thread", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "off",
        incomingThreadTs: undefined,
        messageTs: "1000.1",
      }),
    ).toBeUndefined();
  });

  it("uses first-reply thread when replyToMode=first", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "first",
        incomingThreadTs: undefined,
        messageTs: "1000.2",
      }),
    ).toBe("1000.2");
  });

  it("uses the existing incoming thread regardless of replyToMode", () => {
    expect(
      resolveSlackStreamingThreadHint({
        replyToMode: "off",
        incomingThreadTs: "2000.1",
        messageTs: "1000.3",
      }),
    ).toBe("2000.1");
  });
});

describe("slack preview streaming eligibility", () => {
  it("stays on for room messages when streaming mode is enabled", () => {
    expect(
      shouldEnableSlackPreviewStreaming({
        mode: "partial",
        isDirectMessage: false,
      }),
    ).toBe(true);
  });

  it("stays off for top-level DMs without a reply thread", () => {
    expect(
      shouldEnableSlackPreviewStreaming({
        mode: "partial",
        isDirectMessage: true,
      }),
    ).toBe(false);
  });

  it("allows DM preview when the reply is threaded", () => {
    expect(
      shouldEnableSlackPreviewStreaming({
        mode: "partial",
        isDirectMessage: true,
        threadTs: "1000.1",
      }),
    ).toBe(true);
  });

  it("keeps top-level DMs off even when replyToMode would create a reply thread", () => {
    const streamThreadHint = resolveSlackStreamingThreadHint({
      replyToMode: "all",
      incomingThreadTs: undefined,
      messageTs: "1000.4",
      isThreadReply: false,
    });

    expect(
      shouldEnableSlackPreviewStreaming({
        mode: "partial",
        isDirectMessage: true,
        threadTs: undefined,
      }),
    ).toBe(false);
    expect(streamThreadHint).toBe("1000.4");
  });
});

describe("slack draft stream initialization", () => {
  it("stays off when preview streaming is disabled", () => {
    expect(
      shouldInitializeSlackDraftStream({
        previewStreamingEnabled: false,
        useStreaming: false,
      }),
    ).toBe(false);
  });

  it("stays off when native streaming is active", () => {
    expect(
      shouldInitializeSlackDraftStream({
        previewStreamingEnabled: true,
        useStreaming: true,
      }),
    ).toBe(false);
  });

  it("turns on only for preview-only paths", () => {
    expect(
      shouldInitializeSlackDraftStream({
        previewStreamingEnabled: true,
        useStreaming: false,
      }),
    ).toBe(true);
  });
});

// Smoke-test that isSlackStreamingEnabled returns the expected value for the
// configuration that triggers nativeStreaming (the path fixed by issue #59687).
describe("slack native streaming reasoning leak guard (issue #59687)", () => {
  it("confirms streaming is enabled for partial+nativeStreaming=true (the affected path)", () => {
    // The deliverWithStreaming path is only exercised when isSlackStreamingEnabled
    // returns true. The reasoning guard (payload.isReasoning early return) lives
    // inside that path, so we verify the enabling condition here.
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: true })).toBe(true);
  });

  it("streaming is off when nativeStreaming is false (reasoning leak cannot occur)", () => {
    expect(isSlackStreamingEnabled({ mode: "partial", nativeStreaming: false })).toBe(false);
  });
});
