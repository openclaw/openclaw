import { describe, expect, it } from "vitest";
import {
  projectCompactionPlanningMessages,
  readCompactionPlanningOmittedChars,
} from "./compaction-planning-projection.js";
import type { AgentMessage } from "./runtime/index.js";

describe("compaction planning media projection", () => {
  it("removes image and video payloads while preserving visible text and media metadata", () => {
    const imageTrace = Buffer.from("private-image-payload").toString("base64");
    const videoTrace = Buffer.from("native-video-compaction-marker").toString("base64");
    const imageData = imageTrace.repeat(10_000);
    const videoData = videoTrace.repeat(10_000);
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare the recording and screenshot." },
          { type: "image", data: imageData, mimeType: "image/png" },
          { type: "video", data: videoData, mimeType: "video/mp4" },
          { type: "text", text: "Keep the visible transcript." },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_video",
        toolName: "record_screen",
        isError: false,
        content: [
          { type: "text", text: "Recording captured." },
          { type: "video", data: videoData, mimeType: "video/webm" },
        ],
        timestamp: 2,
      },
    ];

    const projected = projectCompactionPlanningMessages(messages);
    const serialized = JSON.stringify(projected);

    expect(projected).toMatchObject([
      {
        role: "user",
        content: [
          { type: "text", text: "Compare the recording and screenshot." },
          { type: "image", data: "", mimeType: "image/png" },
          { type: "video", data: "", mimeType: "video/mp4" },
          { type: "text", text: "Keep the visible transcript." },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_video",
        toolName: "record_screen",
        isError: false,
        content: [
          { type: "text", text: "Recording captured." },
          { type: "video", data: "", mimeType: "video/webm" },
        ],
        timestamp: 2,
      },
    ]);
    expect(serialized).not.toContain(imageTrace);
    expect(serialized).not.toContain(videoTrace);
    expect(serialized.length).toBeLessThan(1_024);
    expect(projected.map(readCompactionPlanningOmittedChars)).toEqual([0, 0]);
    expect(messages[0]).not.toBe(projected[0]);
    expect(messages[1]).not.toBe(projected[1]);
    expect(JSON.stringify(messages)).toContain(videoTrace);
  });
});
