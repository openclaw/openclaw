// Qa Lab plugin module implements suite launch behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { renderQaMarkdownReport, type QaReportScenario } from "openclaw/plugin-sdk/qa-runtime";
import { toRepoRelativePath } from "./cli-paths.js";
import {
  QA_EVIDENCE_FILENAME,
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { isQaFastModeEnabled } from "./model-selection.js";
import { DEFAULT_QA_PROVIDER_MODE } from "./providers/index.js";
import {
  defaultQaSuiteConcurrencyForTransport,
  normalizeQaTransportId,
} from "./qa-transport-registry.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./run-config.js";
import {
  readQaBootstrapScenarioCatalog,
  type QaSeedScenarioWithSource,
} from "./scenario-catalog.js";
import {
  normalizeQaSuiteConcurrency,
  resolveQaSuiteOutputDir,
  resolveQaSuiteWorkerStartStaggerMs,
  scenarioRequiresIsolatedQaSuiteWorker,
} from "./suite-planning.js";
import {
  buildQaSuiteSummaryJson,
  type QaSuiteResult,
  type QaSuiteRunParams,
  type QaSuiteScenarioResult,
  type QaSuiteSummaryJson,
} from "./suite.js";
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
      executionKind: "suite";
      result: QaUnifiedSuiteResult;
    };

export type QaUnifiedSuiteResult = {
  evidencePath: string;
  outputDir: string;
  report: string;
  reportPath: string;
  scenarios: QaSuiteScenarioResult[];
  summaryPath: string;
};

type QaSuiteExecutionPlan =
  | {
      kind: "flow";
    }
  | {
      kind: "unified";
      scenarios: QaSeedScenarioWithSource[];
      flowScenarios: QaSeedScenarioWithSource[];
      testFileScenariosByKind: Map<QaTestFileExecutionKind, QaTestFileScenario[]>;
    };

const MAX_SHARED_FLOW_PARTITIONS = 4;
const MAX_ISOLATED_FLOW_CONCURRENCY = 8;
const ISOLATED_FLOW_WORKER_START_STAGGER_MS = 1_500;

type QaUnifiedPartitionResult = {
  evidenceSummaries: QaEvidenceSummaryJson[];
  scenarioResults: Array<{
    result: QaSuiteScenarioResult;
    scenarioId: string;
  }>;
};

type QaUnifiedPartitionTask = {
  run: () => Promise<QaUnifiedPartitionResult>;
  weight: number;
};

async function loadQaLabServerRuntime() {
  const { startQaLabServer } = await import("./lab-server.js");
  return startQaLabServer;
}

async function loadQaFlowSuiteRuntime() {
  const [{ runQaFlowSuite }, startLab] = await Promise.all([
    import("./suite.js"),
    loadQaLabServerRuntime(),
  ]);
  return async (params: QaSuiteRunParams | undefined) =>
    await runQaFlowSuite({
      ...params,
      startLab: params?.startLab ?? startLab,
    });
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

function resolveSuiteExecutionPlan(params: QaSuiteRunParams | undefined): QaSuiteExecutionPlan {
  const scenarioIds = params?.scenarioIds ?? [];
  if (scenarioIds.length === 0) {
    return { kind: "flow" };
  }
  const selectedScenarios = resolveRequestedScenarios({
    scenarioIds,
    scenarios: readQaBootstrapScenarioCatalog().scenarios,
  });
  const flowScenarios = selectedScenarios.filter((scenario) => !isQaTestFileScenario(scenario));
  const testFileScenariosByKind = new Map<QaTestFileExecutionKind, QaTestFileScenario[]>();
  for (const scenario of selectedScenarios) {
    if (!isQaTestFileScenario(scenario)) {
      continue;
    }
    const scenarios = testFileScenariosByKind.get(scenario.execution.kind) ?? [];
    scenarios.push(scenario);
    testFileScenariosByKind.set(scenario.execution.kind, scenarios);
  }
  if (testFileScenariosByKind.size === 0) {
    return { kind: "flow" };
  }
  return {
    kind: "unified",
    scenarios: selectedScenarios,
    flowScenarios,
    testFileScenariosByKind,
  };
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
    evidenceMode: runParams?.evidenceMode,
    repoRoot,
    outputDir,
    providerMode,
    primaryModel,
    scenarios: params.scenarios,
    writeEvidenceFile: runParams?.writeEvidenceFile,
  });
}

function rejectFlowOnlySuiteOptionsForUnifiedRun(runParams: QaSuiteRunParams | undefined) {
  if (runParams?.runtimePair) {
    throw new Error("--runtime-pair requires execution.kind: flow scenarios.");
  }
  if (runParams?.forcedRuntime) {
    throw new Error("forced runtime execution requires execution.kind: flow scenarios.");
  }
  if (runParams?.captureRuntimeParityCell) {
    throw new Error("runtime parity capture requires execution.kind: flow scenarios.");
  }
}

function suitePartitionOutputDir(outputDir: string, kind: "flow" | QaTestFileExecutionKind) {
  return path.join(outputDir, kind);
}

function flowSuitePartitionOutputDir(outputDir: string, partition: string) {
  return path.join(suitePartitionOutputDir(outputDir, "flow"), partition);
}

function partitionSharedFlowScenarios(
  scenarios: readonly QaSeedScenarioWithSource[],
  concurrency: number,
) {
  const partitionCount = Math.min(
    Math.max(1, Math.floor(concurrency)),
    MAX_SHARED_FLOW_PARTITIONS,
    scenarios.length,
  );
  const partitions = Array.from({ length: partitionCount }, (): QaSeedScenarioWithSource[] => []);
  for (const [index, scenario] of scenarios.entries()) {
    const partition = partitions[index % partitionCount];
    if (!partition) {
      throw new Error("failed to partition shared QA flow scenarios");
    }
    partition.push(scenario);
  }
  return partitions.filter((partition) => partition.length > 0);
}

async function runWeightedUnifiedPartitionTasks(
  tasks: readonly QaUnifiedPartitionTask[],
  maxWeight: number,
) {
  if (tasks.length === 0) {
    return [];
  }
  const limit = Math.max(1, Math.floor(maxWeight));
  const results: QaUnifiedPartitionResult[] = [];
  let activeWeight = 0;
  let settled = 0;
  let nextIndex = 0;
  return await new Promise<QaUnifiedPartitionResult[]>((resolve, reject) => {
    let firstError: Error | undefined;
    let finished = false;
    const finishIfSettled = () => {
      if (finished || activeWeight > 0) {
        return;
      }
      finished = true;
      if (firstError) {
        reject(firstError);
        return;
      }
      resolve(results);
    };
    const launch = () => {
      if (firstError) {
        finishIfSettled();
        return;
      }
      while (nextIndex < tasks.length) {
        const task = tasks[nextIndex];
        if (!task) {
          return;
        }
        const taskWeight = Math.max(1, Math.min(limit, Math.floor(task.weight)));
        if (activeWeight > 0 && activeWeight + taskWeight > limit) {
          return;
        }
        const index = nextIndex;
        nextIndex += 1;
        activeWeight += taskWeight;
        task.run().then(
          (result) => {
            results[index] = result;
            activeWeight -= taskWeight;
            settled += 1;
            if (settled === tasks.length) {
              finishIfSettled();
              return;
            }
            launch();
          },
          (error: unknown) => {
            firstError = error instanceof Error ? error : new Error(String(error));
            activeWeight -= taskWeight;
            settled += 1;
            finishIfSettled();
          },
        );
      }
      if (settled === tasks.length) {
        finishIfSettled();
      }
    };
    launch();
  });
}

async function readQaSuiteEvidenceSummary(evidencePath: string) {
  return validateQaEvidenceSummaryJson(JSON.parse(await fs.readFile(evidencePath, "utf8")));
}

async function resolveQaSuiteResultEvidenceSummary(result: {
  evidence?: QaEvidenceSummaryJson;
  evidencePath: string;
}) {
  return result.evidence ?? (await readQaSuiteEvidenceSummary(result.evidencePath));
}

function mergeQaEvidenceSummaries(params: {
  evidenceSummaries: readonly QaEvidenceSummaryJson[];
  generatedAt: string;
}) {
  const profiles = [
    ...new Set(
      params.evidenceSummaries
        .map((summary) => summary.profile?.trim())
        .filter((profile): profile is string => Boolean(profile)),
    ),
  ];
  return validateQaEvidenceSummaryJson({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: params.generatedAt,
    evidenceMode:
      params.evidenceSummaries.length > 0 &&
      params.evidenceSummaries.every((summary) => summary.evidenceMode === "slim")
        ? "slim"
        : "full",
    entries: params.evidenceSummaries.flatMap((summary) => summary.entries),
    profile: profiles.length === 1 ? profiles[0] : undefined,
  });
}

function testFileScenarioResultToSuiteScenario(
  result: QaTestFileScenarioRunResult["results"][number],
  repoRoot: string,
): QaSuiteScenarioResult {
  const suiteStatus = result.status === "pass" ? "pass" : "fail";
  const stepStatus = result.status === "skipped" ? "skip" : suiteStatus;
  const logPath = toRepoRelativePath(repoRoot, result.logPath);
  const details = [
    `execution.kind=${result.scenario.execution.kind}`,
    `execution.path=${result.scenario.execution.path}`,
    `log=${logPath}`,
    ...(result.failureMessage ? [`failure=${result.failureMessage}`] : []),
  ].join("\n");
  return {
    name: result.scenario.title,
    status: suiteStatus,
    details,
    steps: [
      {
        name: `Run ${result.scenario.execution.kind} test file`,
        status: stepStatus,
        details,
      },
    ],
  };
}

function renderUnifiedQaSuiteReport(params: {
  finishedAt: Date;
  scenarios: readonly QaSuiteScenarioResult[];
  startedAt: Date;
}) {
  return renderQaMarkdownReport({
    title: "OpenClaw QA Scenario Suite",
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    checks: [],
    scenarios: params.scenarios.map((scenario) => ({
      name: scenario.name,
      status: scenario.status,
      details: scenario.details,
      steps: scenario.steps,
    })) satisfies QaReportScenario[],
  });
}

async function writeUnifiedQaSuiteArtifacts(params: {
  alternateModel: string;
  concurrency: number;
  evidence: QaEvidenceSummaryJson;
  fastMode: boolean;
  finishedAt: Date;
  outputDir: string;
  primaryModel: string;
  providerMode: ReturnType<typeof normalizeQaProviderMode>;
  scenarioIds: readonly string[];
  scenarios: readonly QaSuiteScenarioResult[];
  startedAt: Date;
}) {
  await fs.mkdir(params.outputDir, { recursive: true });
  const evidencePath = path.join(params.outputDir, QA_EVIDENCE_FILENAME);
  const reportPath = path.join(params.outputDir, "qa-suite-report.md");
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  const report = renderUnifiedQaSuiteReport({
    finishedAt: params.finishedAt,
    scenarios: params.scenarios,
    startedAt: params.startedAt,
  });
  const summary = buildQaSuiteSummaryJson({
    alternateModel: params.alternateModel,
    concurrency: params.concurrency,
    evidence: params.evidence,
    fastMode: params.fastMode,
    finishedAt: params.finishedAt,
    primaryModel: params.primaryModel,
    providerMode: params.providerMode,
    scenarioIds: params.scenarioIds,
    scenarios: [...params.scenarios],
    startedAt: params.startedAt,
  }) satisfies QaSuiteSummaryJson;
  await fs.writeFile(evidencePath, `${JSON.stringify(params.evidence, null, 2)}\n`, "utf8");
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return {
    evidencePath,
    outputDir: params.outputDir,
    report,
    reportPath,
    scenarios: [...params.scenarios],
    summaryPath,
  } satisfies QaUnifiedSuiteResult;
}

async function runUnifiedQaSuite(params: {
  plan: Extract<QaSuiteExecutionPlan, { kind: "unified" }>;
  runParams: QaSuiteRunParams | undefined;
}): Promise<QaUnifiedSuiteResult> {
  rejectFlowOnlySuiteOptionsForUnifiedRun(params.runParams);
  const startedAt = new Date();
  const repoRoot = path.resolve(params.runParams?.repoRoot ?? process.cwd());
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, params.runParams?.outputDir);
  const providerMode = normalizeQaProviderMode(
    params.runParams?.providerMode ?? DEFAULT_QA_PROVIDER_MODE,
  );
  const primaryModel =
    params.runParams?.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel =
    params.runParams?.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const fastMode =
    typeof params.runParams?.fastMode === "boolean"
      ? params.runParams.fastMode
      : isQaFastModeEnabled({ primaryModel, alternateModel });
  const transportId = normalizeQaTransportId(params.runParams?.transportId);
  const defaultConcurrency = params.runParams?.channelDriverSelection
    ? 1
    : defaultQaSuiteConcurrencyForTransport(transportId);
  const concurrency = normalizeQaSuiteConcurrency(
    params.runParams?.concurrency,
    params.plan.scenarios.length,
    defaultConcurrency,
  );
  const evidenceSummaries: QaEvidenceSummaryJson[] = [];
  const scenarioResultsById = new Map<string, QaSuiteScenarioResult>();
  const sharedFlowPartitionTasks: QaUnifiedPartitionTask[] = [];
  const isolatedFlowPartitionTasks: QaUnifiedPartitionTask[] = [];
  const testFilePartitionTasks: QaUnifiedPartitionTask[] = [];
  const scriptPartitionTasks: QaUnifiedPartitionTask[] = [];
  if (params.plan.flowScenarios.length > 0) {
    const sharedFlowScenarios = params.plan.flowScenarios.filter(
      (scenario) => !scenarioRequiresIsolatedQaSuiteWorker(scenario),
    );
    const isolatedFlowScenarios = params.plan.flowScenarios.filter(
      scenarioRequiresIsolatedQaSuiteWorker,
    );
    const sharedFlowPartitions = partitionSharedFlowScenarios(sharedFlowScenarios, concurrency);
    const isolatedFlowConcurrency = Math.min(
      concurrency,
      MAX_ISOLATED_FLOW_CONCURRENCY,
      isolatedFlowScenarios.length,
    );
    const isolatedFlowPartitions =
      isolatedFlowConcurrency === 1 && isolatedFlowScenarios.length > 1
        ? isolatedFlowScenarios.map((scenario, index) => ({
            kind: `isolated-${index + 1}`,
            scenarios: [scenario],
            concurrency: 1,
          }))
        : [
            {
              kind: "isolated",
              scenarios: isolatedFlowScenarios,
              concurrency: isolatedFlowConcurrency,
            },
          ];
    const flowPartitions = [
      ...sharedFlowPartitions.map((scenarios, index) => ({
        kind: sharedFlowPartitions.length === 1 ? "shared" : `shared-${index + 1}`,
        scenarios,
        concurrency: 1,
      })),
      ...isolatedFlowPartitions,
    ].filter((partition) => partition.scenarios.length > 0);
    const runFlowSuite = await loadQaFlowSuiteRuntime();
    for (const partition of flowPartitions) {
      const isolatedPartition =
        partition.kind === "isolated" || partition.kind.startsWith("isolated-");
      const task = {
        weight: partition.concurrency,
        run: async () => {
          const result = await runFlowSuite({
            ...params.runParams,
            outputDir:
              flowPartitions.length === 1
                ? suitePartitionOutputDir(outputDir, "flow")
                : flowSuitePartitionOutputDir(outputDir, partition.kind),
            writeEvidenceFile: false,
            providerMode,
            primaryModel,
            alternateModel,
            fastMode,
            concurrency: partition.concurrency,
            workerStartStaggerMs: isolatedPartition
              ? (params.runParams?.workerStartStaggerMs ??
                resolveQaSuiteWorkerStartStaggerMs(
                  partition.concurrency,
                  process.env,
                  ISOLATED_FLOW_WORKER_START_STAGGER_MS,
                ))
              : params.runParams?.workerStartStaggerMs,
            scenarioIds: partition.scenarios.map((scenario) => scenario.id),
          });
          const scenarioResults: QaUnifiedPartitionResult["scenarioResults"] = [];
          for (const [index, scenario] of partition.scenarios.entries()) {
            const scenarioResult = result.scenarios[index];
            if (scenarioResult) {
              scenarioResults.push({ scenarioId: scenario.id, result: scenarioResult });
            }
          }
          return {
            evidenceSummaries: [await resolveQaSuiteResultEvidenceSummary(result)],
            scenarioResults,
          };
        },
      } satisfies QaUnifiedPartitionTask;
      if (isolatedPartition) {
        isolatedFlowPartitionTasks.push(task);
      } else {
        sharedFlowPartitionTasks.push(task);
      }
    }
  }
  const createTestFilePartitionTask = (
    scenariosByKind: ReadonlyMap<QaTestFileExecutionKind, QaTestFileScenario[]>,
  ) =>
    ({
      weight: 1,
      run: async () => {
        const testFileEvidenceSummaries: QaEvidenceSummaryJson[] = [];
        const testFileScenarioResults: QaUnifiedPartitionResult["scenarioResults"] = [];
        for (const [kind, testFileScenarios] of scenariosByKind) {
          const result = await runQaTestFileSuiteFromRuntime({
            runParams: {
              ...params.runParams,
              outputDir: suitePartitionOutputDir(outputDir, kind),
              writeEvidenceFile: false,
              providerMode,
              primaryModel,
              scenarioIds: testFileScenarios.map((scenario) => scenario.id),
            },
            scenarios: testFileScenarios,
          });
          testFileEvidenceSummaries.push(await resolveQaSuiteResultEvidenceSummary(result));
          testFileScenarioResults.push(
            ...result.results.map((scenarioResult) => ({
              scenarioId: scenarioResult.scenario.id,
              result: testFileScenarioResultToSuiteScenario(scenarioResult, repoRoot),
            })),
          );
        }
        return {
          evidenceSummaries: testFileEvidenceSummaries,
          scenarioResults: testFileScenarioResults,
        };
      },
    }) satisfies QaUnifiedPartitionTask;
  const concurrentTestFileScenariosByKind = new Map(
    [...params.plan.testFileScenariosByKind].filter(([kind]) => kind !== "script"),
  );
  if (concurrentTestFileScenariosByKind.size > 0) {
    testFilePartitionTasks.push(createTestFilePartitionTask(concurrentTestFileScenariosByKind));
  }
  const scriptScenarios = params.plan.testFileScenariosByKind.get("script");
  if (scriptScenarios?.length) {
    scriptPartitionTasks.push(createTestFilePartitionTask(new Map([["script", scriptScenarios]])));
  }
  const concurrentPartitionTasks = [
    ...sharedFlowPartitionTasks,
    ...testFilePartitionTasks,
    ...isolatedFlowPartitionTasks,
  ];
  const concurrentPartitionResults = await runWeightedUnifiedPartitionTasks(
    concurrentPartitionTasks,
    concurrency,
  );
  // Script scenarios may rebuild the checkout's shared dist tree. Wait until every
  // flow Gateway has stopped so package postbuild cannot invalidate its loaded chunks.
  const scriptPartitionResults = await runWeightedUnifiedPartitionTasks(scriptPartitionTasks, 1);
  const partitionResults = [...concurrentPartitionResults, ...scriptPartitionResults];
  for (const partitionResult of partitionResults) {
    for (const scenarioResult of partitionResult.scenarioResults) {
      scenarioResultsById.set(scenarioResult.scenarioId, scenarioResult.result);
    }
    evidenceSummaries.push(...partitionResult.evidenceSummaries);
  }
  const finishedAt = new Date();
  const evidence = mergeQaEvidenceSummaries({
    evidenceSummaries,
    generatedAt: finishedAt.toISOString(),
  });
  const scenarios = params.plan.scenarios.map((scenario) => {
    const result = scenarioResultsById.get(scenario.id);
    if (result) {
      return result;
    }
    return {
      name: scenario.title,
      status: "fail",
      details: "suite partition returned no scenario result",
      steps: [
        {
          name: "suite partition",
          status: "fail",
          details: "suite partition returned no scenario result",
        },
      ],
    } satisfies QaSuiteScenarioResult;
  });
  return await writeUnifiedQaSuiteArtifacts({
    alternateModel,
    concurrency,
    evidence,
    fastMode,
    finishedAt,
    outputDir,
    primaryModel,
    providerMode,
    scenarioIds: params.plan.scenarios.map((scenario) => scenario.id),
    scenarios,
    startedAt,
  });
}

export async function runQaSuite(...args: [QaSuiteRunParams?]): Promise<QaSuiteRuntimeResult> {
  const runParams = args[0];
  const plan = resolveSuiteExecutionPlan(runParams);
  if (plan.kind === "unified") {
    const result = await runUnifiedQaSuite({
      runParams,
      plan,
    });
    return {
      executionKind: "suite",
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
  return await (
    await loadQaFlowSuiteRuntime()
  )(args[0]);
}
