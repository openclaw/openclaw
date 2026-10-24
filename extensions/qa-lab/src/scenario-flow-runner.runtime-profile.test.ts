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

  it("loads declared modules and diagnoses missing late imports", async () => {
    const imported = await runActions([
      { call: "qaImport", args: ["./errors.js"], saveAs: "module" },
    ]);
    expect(imported.vars.module).toHaveProperty("QaSuiteScenarioSkipError");
    await expect(
      runActions([{ call: "qaImport", args: ["/fetched/scenario.mjs"] }]),
    ).rejects.toThrow(/not available in this AOT build.*rebuild.*JIT/s);
  });

  it("evaluates expressions", async () => {
    expect((await runValue({ expr: "21 * 2" })).vars.result).toBe(42);
  });

  it.each([false, true])("executes a lambda (async=%s)", async (async) => {
    const { vars } = await runValue({ lambda: { params: ["n"], expr: "n * 2", async } });
    expect(typeof vars.result).toBe("function");
    if (typeof vars.result === "function") {
      expect(await vars.result(21)).toBe(42);
    }
  });
});
