import { describe, expect, it } from "vitest";
import {
  isSlackStreamingEnabled,
  resolveSlackDeliveryThreadTs,
  resolveSlackDraftPreviewThreadTs,
  resolveSlackStreamingThreadHint,
  resolveTrackedSlackBlockReplyThreadTs,
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

describe("slack block delivery thread reuse", () => {
  it("does not reuse the established thread unless block delivery opts in", () => {
    expect(
      resolveSlackDeliveryThreadTs({
        plannedThreadTs: undefined,
        usedReplyThreadTs: "3000.1",
      }),
    ).toBeUndefined();
  });

  it("reuses the established thread when first-mode block planning is exhausted", () => {
    expect(
      resolveSlackDeliveryThreadTs({
        plannedThreadTs: undefined,
        usedReplyThreadTs: "3000.1",
        allowUsedReplyThreadTs: true,
      }),
    ).toBe("3000.1");
  });

  it("still prefers an explicit or newly planned thread over the reused thread", () => {
    expect(
      resolveSlackDeliveryThreadTs({
        forcedThreadTs: "3000.2",
        plannedThreadTs: "3000.3",
        usedReplyThreadTs: "3000.1",
        allowUsedReplyThreadTs: true,
      }),
    ).toBe("3000.2");

    expect(
      resolveSlackDeliveryThreadTs({
        plannedThreadTs: "3000.3",
        usedReplyThreadTs: "3000.1",
        allowUsedReplyThreadTs: true,
      }),
    ).toBe("3000.3");
  });

  it("refreshes the cached block thread when a delivered block uses an explicit thread", () => {
    expect(
      resolveTrackedSlackBlockReplyThreadTs({
        deliveredThreadTs: "reply-tag.1",
        usedBlockReplyThreadTs: "3000.1",
        trackBlockReplyThreadTs: true,
      }),
    ).toBe("reply-tag.1");
  });

  it("keeps the cached block thread when the delivery should not retarget block reuse", () => {
    expect(
      resolveTrackedSlackBlockReplyThreadTs({
        deliveredThreadTs: "reply-tag.1",
        usedBlockReplyThreadTs: "3000.1",
        trackBlockReplyThreadTs: false,
      }),
    ).toBe("3000.1");
  });
});

describe("slack draft preview thread reuse", () => {
  it("does not reuse the cached thread in first mode once planning is exhausted", () => {
    expect(
      resolveSlackDraftPreviewThreadTs({
        replyToMode: "first",
        plannedThreadTs: undefined,
        usedReplyThreadTs: "3000.1",
      }),
    ).toBeUndefined();
  });

  it("can reuse the cached thread in all mode when planning is exhausted", () => {
    expect(
      resolveSlackDraftPreviewThreadTs({
        replyToMode: "all",
        plannedThreadTs: undefined,
        usedReplyThreadTs: "3000.1",
      }),
    ).toBe("3000.1");
  });
});
