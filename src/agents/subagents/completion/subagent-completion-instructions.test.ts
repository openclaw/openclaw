import { describe, expect, it } from "vitest";
import {
  SUBAGENT_COMPLETION_OUTCOME_INSTRUCTION,
  SUBAGENT_COMPLETION_RELAY_ONLY_INSTRUCTION,
  buildSubagentPrivateCompletionInstruction,
  toRelayOnlyCompletionText,
} from "./subagent-completion-instructions.js";

describe("toRelayOnlyCompletionText", () => {
  // Prompt/fragment substitution itself — including the rewritten task-completion
  // events — is asserted at the run seam (attempt-execution.completion-relay.test.ts);
  // only properties that seam cannot show are covered here.
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
