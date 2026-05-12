import { describe, expect, it } from "vitest";
import {
  getReplyPayloadMetadata,
  markReplyPayloadForSourceSuppressionDelivery,
} from "../../../auto-reply/reply-payload.js";
import { mergeAttemptToolMediaPayloads } from "./tool-media-payloads.js";

describe("mergeAttemptToolMediaPayloads", () => {
  it("attaches tool media to the first visible reply", () => {
    expect(
      mergeAttemptToolMediaPayloads({
        payloads: [
          { text: "thinking", isReasoning: true },
          { text: "done", mediaUrls: ["/tmp/a.png"] },
        ],
        toolMediaUrls: ["/tmp/a.png", "/tmp/b.opus"],
        toolAudioAsVoice: true,
      }),
    ).toEqual([
      { text: "thinking", isReasoning: true },
      {
        text: "done",
        mediaUrls: ["/tmp/a.png", "/tmp/b.opus"],
        mediaUrl: "/tmp/a.png",
        audioAsVoice: true,
      },
    ]);
  });

  it("creates a media-only reply when no visible reply exists", () => {
    expect(
      mergeAttemptToolMediaPayloads({
        payloads: [{ text: "thinking", isReasoning: true }],
        toolMediaUrls: ["/tmp/reply.opus"],
        toolAudioAsVoice: true,
      }),
    ).toEqual([
      { text: "thinking", isReasoning: true },
      {
        mediaUrls: ["/tmp/reply.opus"],
        mediaUrl: "/tmp/reply.opus",
        audioAsVoice: true,
      },
    ]);
  });

  it("preserves payload metadata when attaching tool media", () => {
    const payload = markReplyPayloadForSourceSuppressionDelivery({ text: "done" });
    const [merged] =
      mergeAttemptToolMediaPayloads({
        payloads: [payload],
        toolMediaUrls: ["/tmp/render.png"],
      }) ?? [];
    if (!merged) {
      throw new Error("Expected merged payload");
    }

    expect(merged).toMatchObject({
      text: "done",
      mediaUrls: ["/tmp/render.png"],
      mediaUrl: "/tmp/render.png",
    });
    expect(getReplyPayloadMetadata(merged)?.deliverDespiteSourceReplySuppression).toBe(true);
  });
});
