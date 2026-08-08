// Focused registry coverage for native video and legacy image queue capabilities.
import { afterEach, describe, expect, it, vi } from "vitest";
import { testing as replyRunTesting } from "../../auto-reply/reply/reply-run-registry.test-support.js";
import { resetDiagnosticSessionStateForTest } from "../../logging/diagnostic-session-state.js";
import { queueEmbeddedAgentMessageWithOutcome, setActiveEmbeddedRun } from "./runs.js";
import { testing } from "./runs.test-support.js";

type RunHandle = Parameters<typeof setActiveEmbeddedRun>[1];

function createRunHandle(
  options: Pick<
    RunHandle,
    "queueMessage" | "supportsQueueMessageImages" | "supportsQueueMessageMedia"
  >,
): RunHandle {
  return {
    ...options,
    isStreaming: () => true,
    isCompacting: () => false,
    abort: () => {},
  };
}

describe("embedded-agent runner native media queue", () => {
  afterEach(() => {
    testing.resetActiveEmbeddedRuns();
    replyRunTesting.resetReplyRunRegistry();
    resetDiagnosticSessionStateForTest();
    vi.restoreAllMocks();
  });

  it("rejects native video for image-only runs and preserves mixed media when supported", () => {
    const queueMessage = vi.fn(async () => {});
    const image = { type: "image" as const, data: "png", mimeType: "image/png" };
    const video = { type: "video" as const, data: "mp4", mimeType: "video/mp4" };
    const inputMedia = [image, video];
    setActiveEmbeddedRun(
      "session-native-media",
      createRunHandle({ queueMessage, supportsQueueMessageImages: true }),
    );

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-native-media", "inspect both", {
        images: [image],
        inputMedia,
      }),
    ).toEqual({
      queued: false,
      sessionId: "session-native-media",
      reason: "image_input_unsupported",
      gatewayHealth: "live",
    });
    expect(queueMessage).not.toHaveBeenCalled();

    setActiveEmbeddedRun(
      "session-native-media",
      createRunHandle({ queueMessage, supportsQueueMessageMedia: true }),
    );

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-native-media", "inspect both", {
        images: [image],
        inputMedia,
      }).queued,
    ).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("inspect both", { images: [image], inputMedia });
    expect(queueMessage).toHaveBeenCalledTimes(1);
  });

  it("accepts canonical image input on legacy image-capable runs", () => {
    const queueMessage = vi.fn(async () => {});
    const inputMedia = [{ type: "image" as const, data: "png", mimeType: "image/png" }];
    setActiveEmbeddedRun(
      "session-canonical-image",
      createRunHandle({ queueMessage, supportsQueueMessageImages: true }),
    );

    expect(
      queueEmbeddedAgentMessageWithOutcome("session-canonical-image", "inspect", { inputMedia })
        .queued,
    ).toBe(true);
    expect(queueMessage).toHaveBeenCalledWith("inspect", { inputMedia });
  });
});
