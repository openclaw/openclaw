// Qa Lab tests cover model switch eval plugin behavior.
import { describe, expect, it } from "vitest";
import { hasModelSwitchContinuitySignal } from "./model-switch-eval.js";

describe("qa model-switch evaluation", () => {
  it.each([
    [
      "accepts direct handoff replies that mention the kickoff task",
      "Handoff confirmed: I reread QA_KICKOFF_TASK.md and switched to gpt.",
      true,
    ],
    [
      "accepts short mission-oriented switch confirmations",
      "model switch complete. reread the kickoff task; qa mission stays the same.",
      true,
    ],
    [
      "accepts concise kickoff note confirmations",
      "Handoff clean: after the model switch, I reread the kickoff note.",
      true,
    ],
    [
      "accepts concise paraphrases of the kickoff task after a handoff",
      "Handoff is clear: after the model switch, read source and docs first, run seeded qa-channel scenarios, and report worked, failed, blocked, and follow-up.",
      true,
    ],
    [
      "rejects unrelated handoff chatter that never confirms the kickoff reread",
      "subagent-handoff confirmed. qa report update: scenario pass. qa run complete.",
      false,
    ],
    [
      "rejects over-scoped multi-line wrap-ups even if they mention a switch and the mission",
      `model switch acknowledged. qa mission stays the same.

Final QA tally update: all mandatory scenarios resolved. QA run complete.`,
      false,
    ],
  ] as const)("%s", (_name, input, expected) => {
    expect(hasModelSwitchContinuitySignal(input)).toBe(expected);
  });
});
