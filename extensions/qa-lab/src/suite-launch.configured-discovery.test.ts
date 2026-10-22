import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { liveFrontierProviderDefinition } from "./providers/live-frontier/index.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { recordQaSuiteTestResults } from "./suite-test-helpers.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";

const { runQaFlowSuite, runPluginCommandWithTimeout } = vi.hoisted(() => ({
  runQaFlowSuite: vi.fn<typeof import("./suite.js").runQaFlowSuite>(),
  runPluginCommandWithTimeout: vi.fn(),
}));

vi.mock("./suite.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./suite.js")>()),
  runQaFlowSuite,
}));

vi.mock("openclaw/plugin-sdk/run-command", () => ({ runPluginCommandWithTimeout }));

import { runQaSuite } from "./suite-launch.runtime.js";

const tempDirs = createTempDirHarness();
beforeEach(() => {
  runPluginCommandWithTimeout.mockReset().mockResolvedValue({ code: 0, stdout: "", stderr: "" });
  runQaFlowSuite.mockReset().mockImplementation(async (params) => {
    const outputDir = params?.outputDir ?? "/tmp/qa-flow";
    const evidencePath = path.join(outputDir, "qa-evidence.json");
    const scenarioIds = params?.scenarioIds ?? ["channel-chat-baseline"];
    const catalog = params?.scenarioDefinitions ?? readQaBootstrapScenarioCatalog().scenarios;
    const recorded = recordQaSuiteTestResults(
      params,
      scenarioIds.map((id) => catalog.find((scenario) => scenario.id === id)!),
      scenarioIds.map((scenarioId) => ({ name: scenarioId, status: "pass", steps: [] })),
    );
    if (params?.writeEvidenceFile !== false) {
      await fs.mkdir(outputDir, { recursive: true });
      await fs.writeFile(evidencePath, `${JSON.stringify(recorded.evidence, null, 2)}\n`, "utf8");
    }
    return {
      ...recorded,
      outputDir,
      evidencePath,
      reportPath: path.join(outputDir, "qa-suite-report.md"),
      summaryPath: path.join(outputDir, "qa-suite-summary.json"),
      report: "# QA Suite Report\n",
      startedScenarioIds: scenarioIds,
      watchUrl: "http://127.0.0.1:43124",
    };
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await tempDirs.cleanup();
});

const [discovery, general] = ["openai/gpt-5.5", "openai/gpt-5.6-luna"] as const;
it.each([
  ["configured", false, discovery, discovery],
  ["configured", true, discovery, discovery],
  ["defaulted", false, undefined, undefined],
  ["defaulted", false, discovery, undefined],
  ["defaulted", false, undefined, discovery],
  ["defaulted", true, undefined, undefined],
  ["defaulted", true, discovery, undefined],
  ["defaulted", true, undefined, discovery],
  ["general", true, "anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"],
  ["general", true, "google/gemini-2.5-pro", "google/gemini-2.5-pro"],
  ["general", true, general, general],
  ["general", true, discovery, general],
  ["general", true, general, discovery],
] as const)(
  "routes %s (partitioned=%s; models=%s / %s)",
  async (route, partitioned, primaryModel, alternateModel) => {
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
      scenarioIds: [
        "runtime-tool-web-search",
        ...(partitioned ? ["runtime-tool-sessions-spawn"] : []),
      ],
      ...(configured
        ? {}
        : { concurrency: route === "defaulted" ? 2 : 1, workerStartStaggerMs: 0 }),
    });
    if (route === "general") {
      expect(runQaFlowSuite).toHaveBeenCalled();
    } else {
      expect(runQaFlowSuite).toHaveBeenCalledTimes(configured && partitioned ? 2 : 1);
    }
    for (const [params] of runQaFlowSuite.mock.calls) {
      expect(params).toMatchObject({
        primaryModel: primaryModel ?? discovery,
        alternateModel: alternateModel ?? discovery,
      });
      expect(params?.forcedRuntime).toBe(configured ? "codex" : undefined);
      expect(params?.runtimeSelection).toBe(configured ? "configured" : undefined);
      if (configured) {
        expect(params).toMatchObject({ providerMode: "live-frontier", concurrency: 1 });
      }
    }
  },
);
