import { describe, expect, it } from "vitest";
import {
  isSlackStreamingEnabled,
  resolveSlackDeliveryThreadTs,
  resolveSlackStreamingThreadHint,
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

describe("slack block delivery thread reuse", () => {
  it("reuses the established thread when first-mode planning is exhausted", () => {
    expect(
      resolveSlackDeliveryThreadTs({
        plannedThreadTs: undefined,
        usedReplyThreadTs: "3000.1",
      }),
    ).toBe("3000.1");
  });

  it("still prefers an explicit or newly planned thread over the reused thread", () => {
    expect(
      resolveSlackDeliveryThreadTs({
        forcedThreadTs: "3000.2",
        plannedThreadTs: "3000.3",
        usedReplyThreadTs: "3000.1",
      }),
    ).toBe("3000.2");

    expect(
      resolveSlackDeliveryThreadTs({
        plannedThreadTs: "3000.3",
        usedReplyThreadTs: "3000.1",
      }),
    ).toBe("3000.3");
  });
});
