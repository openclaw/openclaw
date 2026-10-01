// Register shared mocks before loading the real suite modules.
import "./suite-run-isolated.test-mocks.js";
import { describe, expect, it, vi } from "vitest";
import * as scenarioCatalog from "./scenario-catalog.js";
import { runQaSuite } from "./suite-launch.runtime.js";
import {
  createCleanupTestContext,
  createCleanupTestLab,
  mocks,
} from "./suite-run-isolated.test-support.js";
import { makeQaSuiteTestScenario } from "./suite-test-helpers.js";
import * as suite from "./suite.js";

vi.mock("./lab-server.js", () => ({ startQaLabServer: vi.fn() }));

describe("implicit QA suite isolated runtimes", () => {
  it.each([
    { forcedRuntime: undefined, expectedPins: ["codex", "openclaw", undefined] },
    { forcedRuntime: "codex", expectedPins: ["codex", "codex", "codex"] },
    { forcedRuntime: "openclaw", expectedPins: ["openclaw", "openclaw", "openclaw"] },
  ] as const)(
    "preserves scenario runtimes with global override $forcedRuntime",
    async ({ forcedRuntime, expectedPins }) => {
      const context = createCleanupTestContext();
      const scenarios = (["codex", "openclaw", undefined] as const).map((runtime) => {
        const scenario = makeQaSuiteTestScenario(runtime ?? "unpinned");
        if (scenario.execution.kind !== "flow") {
          throw new Error("expected flow scenario");
        }
        scenario.execution.runtime = runtime;
        return scenario;
      });
      vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
        agentIdentityMarkdown: "test",
        kickoffTask: "test",
        scenarios,
      });
      const runScenario = vi
        .spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime")
        .mockImplementation(async (_env, scenario) => ({
          name: scenario.title,
          status: "pass",
          steps: [],
        }));

      const { result } = await runQaSuite({
        repoRoot: context.repoRoot,
        outputDir: "output",
        providerMode: "mock-openai",
        scenarioIds: [],
        concurrency: 3,
        workerStartStaggerMs: 0,
        forcedRuntime,
        startLab: async () => createCleanupTestLab(),
      });

      expect(result.scenarios.map(({ status }) => status)).toEqual(["pass", "pass", "pass"]);
      expect(mocks.startQaGatewayChild).toHaveBeenCalledTimes(3);
      expect(mocks.startQaGatewayChild.mock.calls.map(([params]) => params)).toEqual(
        expect.arrayContaining(
          expectedPins.map((runtime) => expect.objectContaining({ forcedRuntime: runtime })),
        ),
      );
      expect(
        runScenario.mock.calls
          .map(([env, scenario]) => [scenario.id, env.runtimeId] as const)
          .toSorted(([left], [right]) => left.localeCompare(right)),
      ).toEqual([
        ["codex", expectedPins[0] ?? "openclaw"],
        ["openclaw", expectedPins[1] ?? "openclaw"],
        ["unpinned", expectedPins[2] ?? "openclaw"],
      ]);
    },
  );
});
