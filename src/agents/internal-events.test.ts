import { describe, expect, it } from "vitest";
import {
  formatAgentInternalEventsForPlainPrompt,
  formatAgentInternalEventsForPrompt,
  MAX_TASK_COMPLETION_RESULT_CHARS,
} from "./internal-events.js";

function buildEvent(result: string) {
  return {
    type: "task_completion" as const,
    source: "subagent" as const,
    childSessionKey: "agent:main:subagent:test",
    childSessionId: "sess_1",
    announceType: "subagent task",
    taskLabel: "Huge output task",
    status: "ok" as const,
    statusLabel: "completed successfully",
    result,
    replyInstruction: "Summarize this result for the user.",
  };
}

describe("agent internal events", () => {
  it("bounds oversized task completion results in runtime-context prompts", () => {
    const hugeResult = `START-${"a".repeat(MAX_TASK_COMPLETION_RESULT_CHARS + 5_000)}-END`;

    const prompt = formatAgentInternalEventsForPrompt([buildEvent(hugeResult)]);

    expect(prompt).toContain("START-");
    expect(prompt).toContain("-END");
    expect(prompt).toContain("OpenClaw truncated oversized child result");
    expect(prompt.length).toBeLessThan(MAX_TASK_COMPLETION_RESULT_CHARS + 3_000);
  });

  it("bounds oversized task completion results in plain prompts", () => {
    const hugeResult = `START-${"b".repeat(MAX_TASK_COMPLETION_RESULT_CHARS + 5_000)}-END`;

    const prompt = formatAgentInternalEventsForPlainPrompt([buildEvent(hugeResult)]);

    expect(prompt).toContain("START-");
    expect(prompt).toContain("-END");
    expect(prompt).toContain("OpenClaw truncated oversized child result");
    expect(prompt.length).toBeLessThan(MAX_TASK_COMPLETION_RESULT_CHARS + 3_000);
  });

  it("does not alter small task completion results", () => {
    const result = "small useful result";

    const prompt = formatAgentInternalEventsForPrompt([buildEvent(result)]);

    expect(prompt).toContain(result);
    expect(prompt).not.toContain("OpenClaw truncated oversized child result");
  });
});
