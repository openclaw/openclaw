import { describe, expect, it } from "vitest";
import {
  buildRuntimeTranscriptRecords,
  extractRuntimeAssistantToolCalls,
  extractRuntimeFinalAssistantText,
  summarizeRuntimeTranscript,
} from "./runtime-transcript.js";

describe("runtime transcript helper", () => {
  it("extracts final assistant text and assistant tool calls from QA JSONL transcripts", () => {
    const transcript = [
      JSON.stringify({ message: { role: "user", content: "hello" } }),
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu-1",
              name: "message",
              input: { action: "send", text: "hi" },
            },
          ],
        },
      }),
      JSON.stringify({
        message: { role: "assistant", content: [{ type: "text", text: "Sent." }] },
      }),
    ].join("\n");

    const records = buildRuntimeTranscriptRecords(transcript);

    expect(extractRuntimeFinalAssistantText(records)).toBe("Sent.");
    expect(extractRuntimeAssistantToolCalls(records)).toEqual([
      {
        id: "toolu-1",
        name: "message",
        args: { action: "send", text: "hi" },
      },
    ]);
    expect(summarizeRuntimeTranscript(transcript)).toMatchObject({
      finalText: "Sent.",
      hasDirectReplySelfMessage: true,
    });
  });

  it("does not flag explicit non-current-chat message sends as direct-reply self-messages", () => {
    const transcript = [
      JSON.stringify({
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              name: "message",
              input: { action: "send", conversationId: "group:qa-reviewers", text: "hello" },
            },
          ],
        },
      }),
      JSON.stringify({ message: { role: "assistant", content: "Sent." } }),
    ].join("\n");

    expect(summarizeRuntimeTranscript(transcript).hasDirectReplySelfMessage).toBe(false);
  });
});
