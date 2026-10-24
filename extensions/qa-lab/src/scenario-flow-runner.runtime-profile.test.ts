import { describe, expect, it, vi } from "vitest";
import { createQaBusState } from "./bus-state.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";

vi.mock("../../../cli-invocation.mjs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../cli-invocation.mjs")>()),
  getStandaloneRuntimeBuild: () => ({ mode: "aot" }),
}));

async function runActions(actions: unknown[]) {
  const vars: Record<string, unknown> = {};
  const result = await runScenarioFlow({
    scenarioTitle: "profile compatibility",
    vars,
    flow: { steps: [{ name: "value", actions }] },
    api: {
      state: createQaBusState(),
      scenario: makeQaSuiteTestScenario("runtime-profile"),
      config: {},
      runScenario: async (name, steps) => {
        for (const step of steps) {
          await step.run();
        }
        return { name, status: "pass", steps: [] };
      },
    },
  });
  return { result, vars };
}

const runValue = (value: unknown) => runActions([{ set: "result", value }]);

describe("QA scenario execution in the embedded AOT profile", () => {
  it("keeps declarative values usable", async () => {
    expect((await runValue({ answer: 42 })).vars.result).toEqual({ answer: 42 });
  });

  it("admits declared modules but rejects late imports through declarative actions", async () => {
    const imported = await runActions([
      { call: "qaImport", args: ["./errors.js"], saveAs: "module" },
    ]);
    expect(imported.vars.module).toHaveProperty("QaSuiteScenarioSkipError");
    await expect(
      runActions([{ call: "qaImport", args: ["/fetched/scenario.mjs"] }]),
    ).rejects.toThrow(/QA scenario source import requires the dynamic-execution runtime profile/);
  });

  it.each([
    { expr: "21 * 2" },
    { lambda: { expr: "21 * 2" } },
    { lambda: { expr: "21 * 2", async: true } },
  ])("reports the required host before evaluating %j", async (value) => {
    await expect(runValue(value)).rejects.toThrow(
      /QA scenario (expression evaluation|lambda creation) requires the dynamic-execution runtime profile.*Node\/Bun/,
    );
  });
});
