import { describe, expect, it } from "vitest";
import {
  formatAgentInternalEventsForPlainPrompt,
  formatAgentInternalEventsForPrompt,
  type AgentInternalEvent,
} from "./internal-events.js";

const MAX_TASK_COMPLETION_RESULT_CHARS = 6_000;
const TASK_COMPLETION_RESULT_TRUNCATION_NOTICE = "\n[child result truncated]";

function buildTaskCompletionEvent(result: string): AgentInternalEvent {
  return {
    type: "task_completion",
    source: "subagent",
    childSessionKey: "agent:main:subagent:test",
    childSessionId: "child-session-id",
    announceType: "subagent task",
    taskLabel: "Inspect output",
    status: "ok",
    statusLabel: "completed; ready for parent review",
    result,
    replyInstruction: "Review the result.",
  };
}

function extractChildResult(prompt: string): string {
  const match = prompt.match(/<prompt-data>\n([\s\S]*?)\n<\/prompt-data>/);
  if (!match?.[1]) {
    throw new Error("Expected child result data block");
  }
  return match[1];
}

describe("agent internal events", () => {
  it("caps protected and plain child-result projections with a visible marker", () => {
    const result = `<${"<".repeat(MAX_TASK_COMPLETION_RESULT_CHARS)}-unbounded-tail`;
    const event = buildTaskCompletionEvent(result);
    const protectedResult = extractChildResult(formatAgentInternalEventsForPrompt([event]));
    const plainResult = extractChildResult(formatAgentInternalEventsForPlainPrompt([event]));

    expect(protectedResult).toBe(plainResult);
    expect(protectedResult.length).toBeLessThanOrEqual(MAX_TASK_COMPLETION_RESULT_CHARS);
    expect(protectedResult.endsWith(TASK_COMPLETION_RESULT_TRUNCATION_NOTICE)).toBe(true);
    expect(protectedResult).not.toContain("unbounded-tail");
  });

  it("does not split a surrogate pair at the child-result limit", () => {
    const prefix = "x".repeat(
      MAX_TASK_COMPLETION_RESULT_CHARS - TASK_COMPLETION_RESULT_TRUNCATION_NOTICE.length - 1,
    );
    const result = `${prefix}😀${"z".repeat(100)}`;
    const projected = extractChildResult(
      formatAgentInternalEventsForPrompt([buildTaskCompletionEvent(result)]),
    );

    expect(projected).toHaveLength(MAX_TASK_COMPLETION_RESULT_CHARS - 1);
    expect(projected.endsWith(TASK_COMPLETION_RESULT_TRUNCATION_NOTICE)).toBe(true);
    expect(projected).not.toContain("😀");
    expect(projected).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("applies the cap after removing collapsible prompt text", () => {
    const result = `${"\0".repeat(MAX_TASK_COMPLETION_RESULT_CHARS)}meaningful-start-${"x".repeat(
      MAX_TASK_COMPLETION_RESULT_CHARS,
    )}`;
    const projected = extractChildResult(
      formatAgentInternalEventsForPrompt([buildTaskCompletionEvent(result)]),
    );

    expect(projected).toHaveLength(MAX_TASK_COMPLETION_RESULT_CHARS);
    expect(projected).toContain("meaningful-start-");
    expect(projected.endsWith(TASK_COMPLETION_RESULT_TRUNCATION_NOTICE)).toBe(true);
  });

  it("keeps ordinary child results unchanged", () => {
    const result = "small useful result";

    const projected = extractChildResult(
      formatAgentInternalEventsForPrompt([buildTaskCompletionEvent(result)]),
    );

    expect(projected).toBe(result);
    expect(projected).not.toContain(TASK_COMPLETION_RESULT_TRUNCATION_NOTICE);
  });
});
