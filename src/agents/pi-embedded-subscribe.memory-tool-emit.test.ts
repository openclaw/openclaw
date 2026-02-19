import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

/**
 * Verify that memory tools (memory_search, memory_get) do not emit tool
 * summaries or output via onToolResult.  Their JSON results contain
 * box-drawing characters and nested markdown that break Telegram's
 * parser in partial-stream mode, silently dropping the final reply.
 */
describe("memory tool emission suppression", () => {
  it("suppresses onToolResult for memory_search but not for a regular tool", async () => {
    const onToolResult = vi.fn();

    const harness = createSubscribedSessionHarness({
      runId: "run-memory-suppress",
      verboseLevel: "on",
      onToolResult,
    });

    // memory_search must NOT trigger onToolResult
    harness.emit({
      type: "tool_execution_start",
      toolName: "memory_search",
      toolCallId: "tool-mem-1",
      args: { query: "prior work" },
    });

    // Wait for any async handler to complete
    await Promise.resolve();

    expect(onToolResult).not.toHaveBeenCalled();

    // A regular tool (read) MUST trigger onToolResult
    harness.emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-read-1",
      args: { path: "/tmp/file.txt" },
    });

    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
  });
});
