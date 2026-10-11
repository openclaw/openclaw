/** Tests the Tool Failures section a compaction summary carries for failed tool results. */
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { describe, expect, it } from "vitest";
import { jsonResult } from "../tools/common.js";
import {
  collectToolFailures,
  formatToolFailuresSection,
} from "./compaction-safeguard-tool-failures.js";

describe("compaction-safeguard tool failures", () => {
  const acceptedDetails = jsonResult({
    status: "accepted",
    childSessionKey: "agent:watcher:subagent:abc",
    runId: "run-123",
    mode: "run",
  }).details;
  const failure = (
    toolCallId: string,
    text: string,
    details?: unknown,
    toolName = "exec",
  ): AgentMessage => ({
    role: "toolResult",
    toolCallId,
    toolName,
    content: [{ type: "text", text }],
    timestamp: 1,
    isError: true,
    details,
  });
  it.each([
    {
      name: "accepted spawn exclusion and look-alike failures",
      messages: [
        failure("call-spawn-accepted", "accepted", acceptedDetails, "sessions_spawn"),
        failure("call-exec-failed", "boom", { status: "failed", exitCode: 1 }),
        failure("call-spawn-error", "spawn rejected", { status: "error" }, "sessions_spawn"),
        failure("call-other-lookalike", "real failure", acceptedDetails, "some_other_tool"),
      ],
      ids: ["call-exec-failed", "call-spawn-error", "call-other-lookalike"],
      expected: ["exec (status=failed exitCode=1): boom"],
      firstSummary: undefined,
    },
    {
      name: "deduplication and empty output",
      messages: [
        { ...failure("call-1", "", { exitCode: 2 }), content: [] },
        failure("call-1", "ignored"),
      ],
      ids: ["call-1"],
      expected: ["exec (exitCode=2): failed"],
      firstSummary: undefined,
    },
    {
      name: "bounded failure counts and UTF-16 summaries",
      messages: Array.from({ length: 9 }, (_, idx) =>
        failure(`call-${idx}`, `${"x".repeat(236)}🚀tail-${idx}`),
      ),
      ids: Array.from({ length: 9 }, (_, idx) => `call-${idx}`),
      expected: ["## Tool Failures", "...and 1 more"],
      firstSummary: `${"x".repeat(236)}...`,
    },
  ])("formats tool failures with $name", ({ messages, ids, expected, firstSummary }) => {
    const failures = collectToolFailures(messages);
    expect(failures.map((entry) => entry.toolCallId)).toEqual(ids);
    const section = formatToolFailuresSection(failures);
    for (const text of expected) {
      expect(section).toContain(text);
    }
    if (firstSummary !== undefined) {
      expect(failures[0]?.summary).toBe(firstSummary);
    }
  });
});
