import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { summarizeSessionContext } from "./attempt-context-summary.js";

describe("summarizeSessionContext", () => {
  it("counts native video separately from images without treating either payload as text", () => {
    const messages: AgentMessage[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "watch this" },
          { type: "image", data: "image-bytes", mimeType: "image/png" },
          { type: "video", data: "first-video", mimeType: "video/mp4" },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "call_video",
        toolName: "record_screen",
        content: [
          { type: "text", text: "recorded" },
          { type: "video", data: "second-video", mimeType: "video/webm" },
        ],
        isError: false,
        timestamp: 2,
      },
    ];

    expect(summarizeSessionContext(messages)).toEqual({
      roleCounts: "toolResult:1,user:1",
      totalTextChars: 18,
      totalImageBlocks: 1,
      totalVideoBlocks: 2,
      maxMessageTextChars: 10,
    });
  });
});
