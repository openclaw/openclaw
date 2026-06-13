// Qa Lab plugin module implements suite launch behavior.
import path from "node:path";
import { DEFAULT_QA_PROVIDER_MODE } from "./providers/index.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./run-config.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { resolveQaSuiteOutputDir } from "./suite-planning.js";
import type { QaSuiteResult, QaSuiteRunParams } from "./suite.js";
import {
  isQaTestFileScenario,
  runQaTestFileScenarios,
  type QaTestFileExecutionKind,
  type QaTestFileScenario,
  type QaTestFileScenarioRunResult,
} from "./test-file-scenario-runner.js";

export type QaSuiteRuntimeResult =
  | {
      executionKind: "flow";
      result: QaSuiteResult;
    }
  | {
      executionKind: QaTestFileExecutionKind;
      result: QaTestFileScenarioRunResult;
    };

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

function resolveTestFileScenariosForSuiteDispatch(
  params: QaSuiteRunParams | undefined,
): QaTestFileScenario[] | null {
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
    throw new Error("qa suite cannot mix execution.kind: flow with Vitest/Playwright scenarios.");
  }
  return testFileScenarios;
}

async function runQaTestFileSuiteFromRuntime(params: {
  runParams: QaSuiteRunParams | undefined;
  scenarios: readonly QaTestFileScenario[];
}): Promise<QaTestFileScenarioRunResult> {
  const runParams = params.runParams;
  if (runParams?.runtimePair) {
    throw new Error("--runtime-pair requires execution.kind: flow scenarios.");
  }
  if (runParams?.forcedRuntime) {
    throw new Error("forced runtime execution requires execution.kind: flow scenarios.");
  }
  if (runParams?.captureRuntimeParityCell) {
    throw new Error("runtime parity capture requires execution.kind: flow scenarios.");
  }
  const repoRoot = path.resolve(runParams?.repoRoot ?? process.cwd());
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, runParams?.outputDir);
  const providerMode = normalizeQaProviderMode(runParams?.providerMode ?? DEFAULT_QA_PROVIDER_MODE);
  const primaryModel = runParams?.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  return await runQaTestFileScenarios({
    repoRoot,
    outputDir,
    providerMode,
    primaryModel,
    scenarios: params.scenarios,
  });
}

export async function runQaSuite(...args: [QaSuiteRunParams?]): Promise<QaSuiteRuntimeResult> {
  const runParams = args[0];
  const testFileScenarios = resolveTestFileScenariosForSuiteDispatch(runParams);
  if (testFileScenarios) {
    const result = await runQaTestFileSuiteFromRuntime({
      runParams,
      scenarios: testFileScenarios,
    });
    return {
      executionKind: result.executionKind,
      result,
    };
  }
  return {
    executionKind: "flow",
    result: await runQaFlowSuiteFromRuntime(...args),
  };
}

export async function runQaFlowSuiteFromRuntime(
  ...args: [QaSuiteRunParams?]
): Promise<QaSuiteResult> {
  const { runQaFlowSuite } = await import("./suite.js");
  const params = args[0];
  return await runQaFlowSuite({
    ...params,
    startLab: params?.startLab ?? (await loadQaLabServerRuntime()),
  });
}
