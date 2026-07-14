import { describe, expect, it } from "vitest";
import { MATRIX_QA_ALL_SCENARIO_IDS, resolveMatrixQaScenarioIds } from "./profiles.js";

describe("QA Lab Matrix profiles", () => {
  it("preserves the legacy profile sizes and default selection", () => {
    expect(MATRIX_QA_ALL_SCENARIO_IDS).toHaveLength(93);
    expect(resolveMatrixQaScenarioIds({ profile: "fast" })).toHaveLength(12);
    expect(resolveMatrixQaScenarioIds({ profile: "release" })).toEqual([
      "channel-chat-baseline",
      "matrix-allowlist-hot-reload",
    ]);
    expect(resolveMatrixQaScenarioIds({ profile: "transport" })).toHaveLength(50);
    expect(resolveMatrixQaScenarioIds({ profile: "media" })).toHaveLength(7);
    expect(resolveMatrixQaScenarioIds({ profile: "e2ee-smoke" })).toHaveLength(8);
    expect(resolveMatrixQaScenarioIds({ profile: "e2ee-deep" })).toHaveLength(18);
    expect(resolveMatrixQaScenarioIds({ profile: "e2ee-cli" })).toHaveLength(9);
    expect(resolveMatrixQaScenarioIds({})).toEqual(MATRIX_QA_ALL_SCENARIO_IDS);
    expect(resolveMatrixQaScenarioIds({ profile: "fast" })).toContain("channel-chat-baseline");
    expect(MATRIX_QA_ALL_SCENARIO_IDS).toContain("channel-chat-baseline");
  });

  it("keeps profile ids unique and excludes the legacy explicit-only scenarios", () => {
    for (const profile of [
      "all",
      "fast",
      "release",
      "transport",
      "media",
      "e2ee-smoke",
      "e2ee-deep",
      "e2ee-cli",
    ]) {
      const scenarioIds = resolveMatrixQaScenarioIds({ profile });
      expect(new Set(scenarioIds).size).toBe(scenarioIds.length);
    }
    expect(MATRIX_QA_ALL_SCENARIO_IDS).not.toContain("matrix-room-block-streaming");
    expect(MATRIX_QA_ALL_SCENARIO_IDS).not.toContain("subagent-thread-spawn");
  });
});
