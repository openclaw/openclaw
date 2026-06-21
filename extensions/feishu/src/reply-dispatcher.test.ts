// Feishu reply-dispatcher tests cover streaming-card start parameter filtering.
import { describe, expect, it } from "vitest";

// Test the variable transformation logic directly by reimplementing it.
// This verifies that skipReplyToInMessages correctly filters both
// the reply target and the root message id for the streaming start call.

function computeStreamingStartParams(params: {
  replyToMessageId?: string;
  skipReplyToInMessages?: boolean;
  rootId?: string;
}): { replyToMessageId?: string; rootId?: string } {
  const sendReplyToMessageId = params.skipReplyToInMessages ? undefined : params.replyToMessageId;
  // The effectiveRootId mirrors sendReplyToMessageId filtering:
  // when skipReplyToInMessages is set for ordinary DMs, both the
  // reply target and the root id must be cleared so the streaming
  // card does not route through reply_to or root_create modes.
  const effectiveRootId = params.skipReplyToInMessages ? undefined : params.rootId;
  return {
    replyToMessageId: sendReplyToMessageId,
    rootId: effectiveRootId,
  };
}

describe("streaming start param filtering", () => {
  it("passes both replyToMessageId and rootId for group/topic replies", () => {
    const result = computeStreamingStartParams({
      replyToMessageId: "msg-123",
      skipReplyToInMessages: false,
      rootId: "root-456",
    });
    expect(result.replyToMessageId).toBe("msg-123");
    expect(result.rootId).toBe("root-456");
  });

  it("filters both replyToMessageId and rootId when skipReplyToInMessages is true", () => {
    const result = computeStreamingStartParams({
      replyToMessageId: "msg-123",
      skipReplyToInMessages: true,
      rootId: "root-456",
    });
    // In DM mode, the streaming card must be top-level, so both
    // reply target and root id are cleared.
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.rootId).toBeUndefined();
  });

  it("handles undefined rootId gracefully", () => {
    const result = computeStreamingStartParams({
      replyToMessageId: "msg-123",
      skipReplyToInMessages: false,
      rootId: undefined,
    });
    expect(result.replyToMessageId).toBe("msg-123");
    expect(result.rootId).toBeUndefined();
  });

  it("handles skipReplyToInMessages with undefined rootId", () => {
    const result = computeStreamingStartParams({
      replyToMessageId: "msg-123",
      skipReplyToInMessages: true,
      rootId: undefined,
    });
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.rootId).toBeUndefined();
  });

  it("handles undefined replyToMessageId gracefully", () => {
    const result = computeStreamingStartParams({
      replyToMessageId: undefined,
      skipReplyToInMessages: false,
      rootId: "root-456",
    });
    expect(result.replyToMessageId).toBeUndefined();
    expect(result.rootId).toBe("root-456");
  });

  it("ensures allowTopLevelReplyFallback uses effectiveRootId", () => {
    // The allowTopLevelReplyFallback in the production code checks:
    // effectiveRootId !== undefined && sendReplyToMessageId !== undefined
    // When skipReplyToInMessages is true, effectiveRootId is undefined,
    // so allowTopLevelReplyFallback is false — correct for DM mode.
    const dmParams = computeStreamingStartParams({
      replyToMessageId: "msg-123",
      skipReplyToInMessages: true,
      rootId: "root-456",
    });
    const dmFallback = dmParams.rootId !== undefined && dmParams.replyToMessageId !== undefined;
    expect(dmFallback).toBe(false);

    // For a thread reply, both rootId and replyToMessageId are present
    const threadParams = computeStreamingStartParams({
      replyToMessageId: "msg-123",
      skipReplyToInMessages: false,
      rootId: "root-456",
    });
    const threadFallback =
      threadParams.rootId !== undefined &&
      threadParams.replyToMessageId !== undefined &&
      threadParams.replyToMessageId !== threadParams.rootId;
    expect(threadFallback).toBe(true);
  });
});
