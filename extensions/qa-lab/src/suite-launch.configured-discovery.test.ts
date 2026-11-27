import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { liveFrontierProviderDefinition } from "./providers/live-frontier/index.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { makeQaSuiteTestResult, recordQaSuiteTestResults } from "./suite-test-helpers.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { runQaFlowSuite } = vi.hoisted(() => ({
  runQaFlowSuite: vi.fn<typeof import("./suite.js").runQaFlowSuite>(),
}));

vi.mock("./suite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite.js")>()),
  runQaFlowSuite,
}));

import { runQaSuite } from "./suite-launch.runtime.js";

const tempDirs = createTempDirHarness();
beforeEach(() => {
  runQaFlowSuite.mockReset().mockImplementation(async (params) => {
    const outputDir = params?.outputDir ?? "/tmp/qa-flow";
    const scenarioIds = params?.scenarioIds ?? ["channel-chat-baseline"];
    const catalog = params?.scenarioDefinitions ?? readQaBootstrapScenarioCatalog().scenarios;
    const recorded = recordQaSuiteTestResults(
      params,
      scenarioIds.map((id) => catalog.find((scenario) => scenario.id === id)!),
      scenarioIds.map((scenarioId) => ({ name: scenarioId, status: "pass", steps: [] })),
    );
    return makeQaSuiteTestResult(recorded, outputDir, scenarioIds);
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

const [discovery, general] = ["openai/gpt-5.5", "openai/gpt-5.6-luna"] as const;
it.each([
  ["configured", discovery, discovery],
  ["defaulted", undefined, undefined],
  ["general", general, general],
  ["general", discovery, general],
  ["general", general, discovery],
] as const)(
  "routes %s models through suite partitions",
  async (route, primaryModel, alternateModel) => {
    const configured = route === "configured";
    if (route === "defaulted") {
      vi.spyOn(liveFrontierProviderDefinition, "defaultModel").mockReturnValue(discovery);
    }
    await runQaSuite({
      repoRoot: await tempDirs.makeTempDir("qa-suite-discovery-route-"),
      outputDir: ".artifacts/discovery",
      providerMode: "live-frontier",
      primaryModel,
      alternateModel,
      scenarioIds: ["runtime-tool-web-search", "runtime-tool-sessions-spawn"],
      ...(configured
        ? {}
        : { concurrency: route === "defaulted" ? 2 : 1, workerStartStaggerMs: 0 }),
    });
    if (route === "general") {
      expect(runQaFlowSuite).toHaveBeenCalled();
    } else {
      expect(runQaFlowSuite).toHaveBeenCalledTimes(configured ? 2 : 1);
    }
    for (const [params] of runQaFlowSuite.mock.calls) {
      expect(params).toMatchObject({
        primaryModel: primaryModel ?? discovery,
        alternateModel: alternateModel ?? discovery,
        forcedRuntime: configured ? "codex" : undefined,
        runtimeSelection: configured ? "configured" : undefined,
        ...(configured ? { providerMode: "live-frontier", concurrency: 1 } : {}),
      });
    }
  },
);
