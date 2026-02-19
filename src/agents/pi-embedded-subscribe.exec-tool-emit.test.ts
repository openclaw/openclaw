import { describe, expect, it, vi } from "vitest";
import { createSubscribedSessionHarness } from "./pi-embedded-subscribe.e2e-harness.js";

/**
 * Verify that exec/bash tool results do not emit summaries or output
 * via onToolResult.  Raw shell commands and their stdout/stderr contain
 * workspace paths, credentials, and internal implementation details
 * that should never be forwarded to channel users.
 */
describe("exec tool emission suppression", () => {
  it("suppresses onToolResult for exec tool events", async () => {
    const onToolResult = vi.fn();

    const { emit } = createSubscribedSessionHarness({
      runId: "run-exec-suppress",
      verboseLevel: "on",
      onToolResult,
    });

    emit({
      type: "tool_execution_start",
      toolName: "exec",
      toolCallId: "tool-exec-1",
      args: { command: "ls -la /workspace" },
    });

    await Promise.resolve();

    expect(onToolResult).not.toHaveBeenCalled();
  });

  it("does not suppress onToolResult for non-exec tool events", async () => {
    const onToolResult = vi.fn();

    const { emit } = createSubscribedSessionHarness({
      runId: "run-read-emit",
      verboseLevel: "on",
      onToolResult,
    });

    emit({
      type: "tool_execution_start",
      toolName: "read",
      toolCallId: "tool-read-1",
      args: { path: "/tmp/file.txt" },
    });

    await Promise.resolve();

    expect(onToolResult).toHaveBeenCalledTimes(1);
  });
});
