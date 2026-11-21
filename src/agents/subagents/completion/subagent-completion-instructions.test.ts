import { describe, expect, it } from "vitest";
import type { AgentInternalEvent } from "../../internal-events.js";
import {
  SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
  SUBAGENT_COMPLETION_RELAY_ONLY_INSTRUCTION,
  buildSubagentPrivateCompletionInstruction,
  toRelayOnlyCompletionInternalEvents,
  toRelayOnlyCompletionText,
} from "./subagent-completion-instructions.js";

const completionEvent = (replyInstruction: string): AgentInternalEvent => ({
  type: "task_completion",
  source: "subagent",
  childSessionKey: "agent:main:subagent:child",
  announceType: "subagent task",
  taskLabel: "review",
  status: "ok",
  statusLabel: "completed",
  result: "child output",
  replyInstruction,
});

describe("toRelayOnlyCompletionText", () => {
  // Prompt/fragment substitution itself is asserted at the run seam
  // (attempt-execution.completion-relay.test.ts); only properties that seam
  // cannot show are covered here.
  it("leaves text without the shared instruction untouched", () => {
    expect(toRelayOnlyCompletionText("plain relay text")).toBe("plain relay text");
  });

  it("rewrites the private completion instruction too", () => {
    const privateInstruction = buildSubagentPrivateCompletionInstruction(undefined);
    const rewritten = toRelayOnlyCompletionText(privateInstruction);
    expect(rewritten).toContain(SUBAGENT_COMPLETION_RELAY_ONLY_INSTRUCTION);
    expect(rewritten).not.toContain(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION);
  });
});

describe("toRelayOnlyCompletionInternalEvents", () => {
  it("rewrites only the task-completion reply instruction", () => {
    // Event-level selectivity is not observable at the run seam.
    const events = [completionEvent(`Review it. ${SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION}`)];
    const rewritten = toRelayOnlyCompletionInternalEvents(events);
    expect(rewritten?.[0]).toMatchObject({
      type: "task_completion",
      replyInstruction: expect.stringContaining(SUBAGENT_COMPLETION_RELAY_ONLY_INSTRUCTION),
    });
    expect(rewritten?.[0]?.replyInstruction).not.toContain(SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION);
  });
});
