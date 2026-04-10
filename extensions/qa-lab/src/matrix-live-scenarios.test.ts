import { describe, expect, it } from "vitest";
import { __testing as scenarioTesting } from "./matrix-live-scenarios.js";

describe("matrix live qa scenarios", () => {
  it("ships the Matrix live QA scenario set by default", () => {
    expect(scenarioTesting.findMatrixQaScenarios().map((scenario) => scenario.id)).toEqual([
      "matrix-thread-follow-up",
      "matrix-thread-isolation",
      "matrix-top-level-reply-shape",
      "matrix-mention-gating",
      "matrix-allowlist-block",
    ]);
  });

  it("uses the repo-wide exact marker prompt shape for Matrix mentions", () => {
    expect(
      scenarioTesting.buildMentionPrompt("@sut:matrix-qa.test", "MATRIX_QA_CANARY_TOKEN"),
    ).toBe("@sut:matrix-qa.test reply with only this exact marker: MATRIX_QA_CANARY_TOKEN");
  });

  it("fails when any requested Matrix scenario id is unknown", () => {
    expect(() =>
      scenarioTesting.findMatrixQaScenarios(["matrix-thread-follow-up", "typo-scenario"]),
    ).toThrow("unknown Matrix QA scenario id(s): typo-scenario");
  });
});
