import { describe, expect, it } from "vitest";
import {
  assertQaRuntimeSuiteScenarioMembership,
  QA_RUNTIME_FIRST_HOUR_20_SCENARIO_IDS,
  QA_RUNTIME_FIRST_HOUR_SCENARIO_IDS,
  QA_RUNTIME_SOAK_100_SCENARIO_IDS,
  QA_RUNTIME_TOOL_DEFAULT_SCENARIO_IDS,
  resolveQaRuntimeSuiteScenarioIds,
} from "./runtime-suite.js";
import { readQaScenarioPack } from "./scenario-catalog.js";

describe("runtime suite resolver", () => {
  it("resolves stable scenario ids for every named runtime suite", () => {
    expect(resolveQaRuntimeSuiteScenarioIds({ runtimeSuite: "first-hour" })).toEqual([
      ...QA_RUNTIME_FIRST_HOUR_SCENARIO_IDS,
    ]);
    expect(resolveQaRuntimeSuiteScenarioIds({ runtimeSuite: "first-hour-20" })).toEqual([
      ...QA_RUNTIME_FIRST_HOUR_20_SCENARIO_IDS,
    ]);
    expect(resolveQaRuntimeSuiteScenarioIds({ runtimeSuite: "tool-defaults" })).toEqual([
      ...QA_RUNTIME_TOOL_DEFAULT_SCENARIO_IDS,
    ]);
    expect(resolveQaRuntimeSuiteScenarioIds({ runtimeSuite: "soak-100" })).toEqual([
      ...QA_RUNTIME_SOAK_100_SCENARIO_IDS,
    ]);
  });

  it("keeps explicit scenarios while adding suite scenarios", () => {
    expect(
      resolveQaRuntimeSuiteScenarioIds({
        runtimeSuite: "first-hour",
        scenarioIds: ["custom-one", "approval-turn-tool-followthrough"],
      }).slice(0, 2),
    ).toEqual(["custom-one", "approval-turn-tool-followthrough"]);
  });

  it("validates catalog tier membership for all built-in suites", () => {
    const scenarios = readQaScenarioPack().scenarios;

    for (const runtimeSuite of ["first-hour", "first-hour-20", "tool-defaults", "soak-100"]) {
      expect(() =>
        assertQaRuntimeSuiteScenarioMembership({
          runtimeSuite,
          scenarios,
        }),
      ).not.toThrow();
    }
  });

  it("rejects missing suite tier metadata", () => {
    const scenarios = [...readQaScenarioPack().scenarios];
    const index = scenarios.findIndex(
      (scenario) => scenario.id === "approval-turn-tool-followthrough",
    );
    expect(index).toBeGreaterThanOrEqual(0);
    scenarios[index] = Object.assign({}, scenarios[index], { runtimeParityTier: undefined });

    expect(() =>
      assertQaRuntimeSuiteScenarioMembership({
        runtimeSuite: "first-hour",
        scenarios,
      }),
    ).toThrow("missing or invalid runtimeParityTier");
  });
});
