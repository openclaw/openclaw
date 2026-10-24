// Register shared mocks before loading the real suite modules.
import "./suite-run-isolated.test-mocks.js";
import { expect, it, vi } from "vitest";
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

async function runIsolated(concurrency: number, params: Parameters<typeof runQaSuite>[0]) {
  const runScenario = vi.spyOn(suite, "runQaSuiteScenarioDefinitionForRuntime");
  runScenario.mockImplementation(async (_env, { title: name }) => ({
    name,
    status: "pass",
    steps: [],
  }));
  const outcome = await runQaSuite({
    repoRoot: createCleanupTestContext().repoRoot,
    outputDir: "output",
    providerMode: "mock-openai",
    workerStartStaggerMs: 0,
    startLab: async () => createCleanupTestLab(),
    concurrency,
    ...params,
  });
  expect(outcome.result.scenarios.map(({ status }) => status)).toEqual(
    Array.from({ length: concurrency }, () => "pass"),
  );
  expect(mocks.startQaGatewayChild).toHaveBeenCalledTimes(concurrency);
  expect(runScenario).toHaveBeenCalledTimes(concurrency);
  return runScenario.mock.calls;
}

it.each([undefined, false])(
  "publishes isolated Control UI only when enabled (override=%s)",
  async (controlUiEnabled) => {
    const scenarios = ["first", "second"].map((id) =>
      makeQaSuiteTestScenario(id, { surface: "control-ui" }),
    );
    const runs = await runIsolated(2, {
      scenarioIds: scenarios.map(({ id }) => id),
      scenarioDefinitions: scenarios,
      controlUiEnabled,
    });

    for (const [env] of runs) {
      if (controlUiEnabled === false) {
        expect(env.lab.setControlUi).not.toHaveBeenCalled();
      } else {
        expect(env.lab.setControlUi).toHaveBeenCalledWith({
          controlUiProxyTarget: "http://127.0.0.1:18789",
          controlUiProxyToken: "qa-test-token",
        });
      }
    }
  },
);

it("preserves scenario runtimes without a global override", async () => {
  const expectedPins = ["codex", "openclaw", undefined] as const;
  const scenarios = expectedPins.map((runtime) =>
    makeQaSuiteTestScenario(runtime ?? "unpinned", { runtime }),
  );
  vi.spyOn(scenarioCatalog, "readQaBootstrapScenarioCatalog").mockReturnValue({
    agentIdentityMarkdown: "test",
    kickoffTask: "test",
    scenarios,
  });
  const runs = await runIsolated(3, { scenarioIds: [] });

  expect(mocks.startQaGatewayChild.mock.calls).toEqual(
    expect.arrayContaining(
      expectedPins.map((forcedRuntime) => [expect.objectContaining({ forcedRuntime })]),
    ),
  );
  const runtimes = Object.fromEntries(runs.map(([env, scenario]) => [scenario.id, env.runtimeId]));
  expect(runtimes).toEqual({ codex: "codex", openclaw: "openclaw", unpinned: "openclaw" });
});
