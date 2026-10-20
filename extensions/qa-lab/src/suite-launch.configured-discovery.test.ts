import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const makeTempRepo = tempDirs.makeTempDir;

async function runSelection(partitioned: boolean, selection: Parameters<typeof runQaSuite>[0]) {
  await runQaSuite({
    repoRoot: await makeTempRepo("qa-suite-discovery-route-"),
    outputDir: ".artifacts/discovery",
    providerMode: "live-frontier",
    scenarioIds: [
      "runtime-tool-web-search",
      ...(partitioned ? ["runtime-tool-sessions-spawn"] : []),
    ],
    ...selection,
  });
}
function expectRoutes(primaryModel: string, alternateModel: string, configured = false) {
  for (const [params] of runQaFlowSuite.mock.calls) {
    expect(params).toMatchObject({ primaryModel, alternateModel });
    expect(params?.forcedRuntime).toBe(configured ? "codex" : undefined);
    expect(params?.runtimeSelection).toBe(configured ? "configured" : undefined);
    if (configured) {
      expect(params).toMatchObject({ providerMode: "live-frontier", concurrency: 1 });
    }
  }
}

describe("qa suite configured discovery routing", () => {
  beforeEach(() => {
    runPluginCommandWithTimeout.mockReset();
    runPluginCommandWithTimeout.mockResolvedValue({ code: 0, stdout: "", stderr: "" });
    runQaFlowSuite.mockReset();
    runQaFlowSuite.mockImplementation(async (params) => {
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
    vi.unstubAllEnvs();
    await tempDirs.cleanup();
  });

  it.each([false, true])(
    "prepares configured discovery identically for singleton and partitioned runs (partitioned=%s)",
    async (partitioned) => {
      await runSelection(partitioned, {
        primaryModel: "openai/gpt-5.5",
        alternateModel: "openai/gpt-5.5",
      });
      expect(runQaFlowSuite).toHaveBeenCalledTimes(partitioned ? 2 : 1);
      expectRoutes("openai/gpt-5.5", "openai/gpt-5.5", true);
    },
  );

  describe.each([false, true])("omitted model slots (partitioned=%s)", (partitioned) => {
    it.each([{}, { primaryModel: "openai/gpt-5.5" }, { alternateModel: "openai/gpt-5.5" }])(
      "keeps defaulted discovery models on the general route: %j",
      async (selection) => {
        vi.spyOn(liveFrontierProviderDefinition, "defaultModel").mockReturnValue("openai/gpt-5.5");
        await runSelection(partitioned, {
          ...selection,
          concurrency: 2,
          workerStartStaggerMs: 0,
        });
        expect(runQaFlowSuite).toHaveBeenCalledTimes(1);
        expectRoutes("openai/gpt-5.5", "openai/gpt-5.5");
      },
    );
  });

  it.each([
    ["anthropic/claude-sonnet-4-5", "anthropic/claude-sonnet-4-5"],
    ["google/gemini-2.5-pro", "google/gemini-2.5-pro"],
    ["openai/gpt-5.6-luna", "openai/gpt-5.6-luna"],
    ["openai/gpt-5.5", "openai/gpt-5.6-luna"],
    ["openai/gpt-5.6-luna", "openai/gpt-5.5"],
  ])("preserves general model routes for %s / %s", async (primaryModel, alternateModel) => {
    await runSelection(true, {
      primaryModel,
      alternateModel,
      concurrency: 1,
      workerStartStaggerMs: 0,
    });
    expect(runQaFlowSuite).toHaveBeenCalled();
    expectRoutes(primaryModel, alternateModel);
  });
});
