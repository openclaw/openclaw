import { describe, expect, it } from "vitest";
import {
  collectCompletedClientToolCalls,
  hasVisiblePendingToolMediaReply,
  normalizeEmbeddedAttemptToolMetas,
} from "./attempt-result.js";

describe("attempt result projection", () => {
  it("keeps completed client tool calls in reserved source order", () => {
    expect(
      collectCompletedClientToolCalls([
        { toolCallId: "first", name: "search", params: { query: "one" }, completed: true },
        { toolCallId: "second", name: "search", completed: false },
        { toolCallId: "third", name: "fetch", params: { id: 3 }, completed: true },
      ]),
    ).toEqual([
      { name: "search", params: { query: "one" } },
      { name: "fetch", params: { id: 3 } },
    ]);
  });

  it("filters invalid tool metadata and preserves terminal flags", () => {
    expect(
      normalizeEmbeddedAttemptToolMetas([
        { toolName: "", replaySafe: true },
        {
          toolName: "exec",
          meta: "done",
          replaySafe: true,
          isError: true,
          asyncStarted: true,
          asyncTaskRunId: "run-1",
          asyncTaskId: "task-1",
        },
      ]),
    ).toEqual([
      {
        toolName: "exec",
        meta: "done",
        replaySafe: true,
        isError: true,
        asyncStarted: true,
        asyncTaskRunId: "run-1",
        asyncTaskId: "task-1",
      },
    ]);
  });

  it("only counts visible media or voice replies", () => {
    expect(hasVisiblePendingToolMediaReply(undefined)).toBe(false);
    expect(hasVisiblePendingToolMediaReply({ mediaUrls: [" "] })).toBe(false);
    expect(hasVisiblePendingToolMediaReply({ mediaUrls: ["file:///tmp/result.png"] })).toBe(true);
    expect(hasVisiblePendingToolMediaReply({ audioAsVoice: true })).toBe(true);
  });
});
