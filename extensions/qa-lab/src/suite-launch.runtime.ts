// Qa Lab plugin module implements suite launch behavior.
import path from "node:path";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./run-config.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { resolveQaSuiteOutputDir } from "./suite-planning.js";
import type { QaSuiteResult, QaSuiteRunParams } from "./suite.js";
import {
  isQaTestFileScenario,
  runQaTestFileScenarios,
  type QaTestFileScenarioRunResult,
} from "./test-file-scenario-runner.js";

export type QaSuiteRuntimeResult = QaSuiteResult | QaTestFileScenarioRunResult;

async function loadQaLabServerRuntime() {
  const { startQaLabServer } = await import("./lab-server.js");
  return startQaLabServer;
}

function resolveRequestedScenarios(params: {
  scenarioIds: readonly string[];
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
}) {
  const scenarioById = new Map(params.scenarios.map((scenario) => [scenario.id, scenario]));
  return params.scenarioIds.map((scenarioId) => {
    const scenario = scenarioById.get(scenarioId);
    if (!scenario) {
      throw new Error(`unknown QA scenario id(s): ${scenarioId}`);
    }
    return scenario;
  });
}

async function runQaTestFileSuiteIfSelected(
  params: QaSuiteRunParams | undefined,
): Promise<QaTestFileScenarioRunResult | null> {
  const scenarioIds = params?.scenarioIds ?? [];
  if (scenarioIds.length === 0) {
    return null;
  }
  const selectedScenarios = resolveRequestedScenarios({
    scenarioIds,
    scenarios: readQaBootstrapScenarioCatalog().scenarios,
  });
  const testFileScenarios = selectedScenarios.filter(isQaTestFileScenario);
  if (testFileScenarios.length === 0) {
    return null;
  }
  if (testFileScenarios.length !== selectedScenarios.length) {
    throw new Error("qa suite cannot mix execution.kind: flow and test-file scenarios.");
  }
  if (params?.runtimePair) {
    throw new Error("--runtime-pair requires execution.kind: flow scenarios.");
  }
  if (params?.forcedRuntime) {
    throw new Error("forced runtime execution requires execution.kind: flow scenarios.");
  }
  if (params?.captureRuntimeParityCell) {
    throw new Error("runtime parity capture requires execution.kind: flow scenarios.");
  }
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, params?.outputDir);
  const providerMode = normalizeQaProviderMode(params?.providerMode);
  const primaryModel = params?.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  return await runQaTestFileScenarios({
    repoRoot,
    outputDir,
    providerMode,
    primaryModel,
    scenarios: testFileScenarios,
  });
}

export async function runQaSuiteFromRuntime(
  ...args: [QaSuiteRunParams?]
): Promise<QaSuiteRuntimeResult> {
  const testFileResult = await runQaTestFileSuiteIfSelected(args[0]);
  if (testFileResult) {
    return testFileResult;
  }
  const { runQaSuite } = await import("./suite.js");
  const params = args[0];
  return await runQaSuite({
    ...params,
    startLab: params?.startLab ?? (await loadQaLabServerRuntime()),
  });
}
