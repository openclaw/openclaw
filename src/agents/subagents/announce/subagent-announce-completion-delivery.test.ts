// Completion predicates read recorded facts, not rendered placeholder wording.
import { describe, expect, it } from "vitest";
import { hasFailedSubagentNoOutputCompletion } from "../../internal-event-contract.js";

const failedChild = { type: "task_completion", source: "subagent", status: "error" } as const;

describe("hasFailedSubagentNoOutputCompletion", () => {
  it.each([
    [
      "recorded no visible result",
      { ...failedChild, result: "(no output)", noVisibleResult: true },
      true,
    ],
    [
      "reworded placeholder",
      { ...failedChild, result: "(nothing to report)", noVisibleResult: true },
      true,
    ],
    ["real result resembling placeholder", { ...failedChild, result: "(no output)" }, false],
    [
      "successful child",
      { ...failedChild, status: "ok", result: "(no output)", noVisibleResult: true },
      false,
    ],
    [
      "non-subagent source",
      { ...failedChild, source: "image_generation", result: "(no output)", noVisibleResult: true },
      false,
    ],
  ] as const)("classifies %s from the recorded result fact", (_label, event, expected) => {
    expect(hasFailedSubagentNoOutputCompletion([event])).toBe(expected);
  });

  it("reports nothing for an absent or empty event list", () => {
    expect(hasFailedSubagentNoOutputCompletion(undefined)).toBe(false);
    expect(hasFailedSubagentNoOutputCompletion([])).toBe(false);
  });
});
