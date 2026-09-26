import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { withCommandProcessScope } from "openclaw/plugin-sdk/process-runtime";
import { runPluginCommandWithTimeout } from "openclaw/plugin-sdk/run-command";
import { toRepoRelativePath } from "./cli-paths.js";
import { isQaSuiteInfraRetryableError, QaSuiteCleanupError } from "./errors.js";
import { captureQaEvidenceLaunchIdentity } from "./evidence-environment.js";
import { resolveQaEvidenceContainment } from "./evidence-summary-schema.js";
import {
  QA_EVIDENCE_FILENAME,
  mergeQaEvidenceSummaries,
  validateQaEvidenceSummaryJson,
  type QaEvidenceSummaryJson,
} from "./evidence-summary.js";
import { isQaFastModeEnabled } from "./model-selection.js";
import { resolveQaRuntimeModelPair } from "./model-selection.runtime.js";
import { DEFAULT_QA_PROVIDER_MODE } from "./providers/index.js";
import {
  defaultQaSuiteConcurrencyForTransport,
  normalizeQaTransportId,
  prepareQaTransportAdapterFactories,
  type QaTransportDriver,
} from "./qa-transport-registry.js";
import { renderQaMarkdownReport } from "./report.js";
import { defaultQaModelForMode, normalizeQaProviderMode } from "./run-config.js";
import {
  readQaBootstrapScenarioCatalog,
  resolveQaScenarioRequiredProviderMode,
  type QaSeedScenarioWithSource,
  type QaTestFileExecutionKind,
  type QaTestFileScenario,
} from "./scenario-catalog.js";
import { expandQaScenarioExecutionCells, type QaScenarioExecutionCell } from "./scenario-lane.js";
import {
  invalidateQaSuiteArtifactGeneration,
  publishQaSuiteArtifactFiles,
} from "./suite-artifacts.js";
import {
  createQaPartitionEvidenceOwner,
  describeQaSuiteInterruption,
  type QaUnifiedPartitionResult,
} from "./suite-evidence.js";
import {
  mapQaSuiteWithConcurrency,
  normalizeQaSuiteConcurrency,
  normalizeQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannels,
  resolveQaSuiteOutputDir,
  resolveQaSuiteWorkerStartStaggerMs,
  runWeightedQaSuiteTasks,
  scenarioRequiresIsolatedQaSuiteWorker,
} from "./suite-planning.js";
import { createQaSuiteProgressController } from "./suite-progress.js";
import { rejectRemovedQaChannelDriverSelection } from "./suite-types.js";
import {
  buildQaSuiteSummaryJson,
  shouldLogQaSuiteProgress,
  type QaSuiteResult,
  type QaSuiteRunParams,
  type QaSuiteScenarioResult,
  type QaSuiteSummaryJson,
  writeQaSuiteProgress,
} from "./suite.js";
import { runQaScenarioCommandLifecycle } from "./test-file-scenario-command-lifecycle.js";
import * as dockerBatch from "./test-file-scenario-docker-batch.js";
import {
  isQaTestFileScenario,
  runQaTestFileScenarios,
  type QaTestFileScenarioRunResult,
} from "./test-file-scenario-runner.js";

export type QaSuiteRuntimeResult = {
  expectedCells: QaScenarioExecutionCell[];
  observedCells: QaScenarioExecutionCell[];
} & (
  | {
      executionKind: "flow";
      result: QaSuiteResult;
    }
  | {
      executionKind: "suite";
      result: QaUnifiedSuiteResult;
    }
);

type QaUnifiedSuiteResult = {
  evidencePath: string;
  outputDir: string;
  report: string;
  reportPath: string;
  scenarios: QaSuiteScenarioResult[];
  summaryPath: string;
};

type QaSuiteExecutionPlan = {
  expectedCells: QaScenarioExecutionCell[];
  scenarios: QaSeedScenarioWithSource[];
} & (
  | {
      kind: "flow";
    }
  | {
      kind: "unified";
      channelGroups: QaFlowChannelGroup[];
      testFileScenariosByKind: Map<QaTestFileExecutionKind, QaTestFileScenario[]>;
    }
);

const MAX_SHARED_FLOW_PARTITIONS = 4;
const MAX_ISOLATED_FLOW_CONCURRENCY = 8;
// Three is the audited ceiling for concurrent Gateway and process-group lifecycles.
// Raising it risks cleanup overlap and shared port/listener contention.
const MAX_PARALLEL_SCRIPT_CONCURRENCY = 3;
const ISOLATED_FLOW_WORKER_START_STAGGER_MS = 1_500;
const QA_SUITE_INFRA_RETRY_LIMIT = 1;
const CREDENTIAL_POOL_UNAVAILABLE_CODES = new Set(["NO_CREDENTIAL_AVAILABLE", "POOL_EXHAUSTED"]);

type QaUnifiedPartitionTask = {
  channel?: string;
  channelId: string;
  exclusiveKey?: string;
  run: () => Promise<QaUnifiedPartitionResult>;
  scenarios: readonly QaSeedScenarioWithSource[];
  weight: number;
  evidenceOwners: QaPartitionEvidenceOwner[];
};

type QaPartitionEvidenceOwner = ReturnType<typeof createQaPartitionEvidenceOwner>;

function summarizeQaEvidenceChannel(
  summaries: readonly QaEvidenceSummaryJson[],
): { id?: string; driver: QaTransportDriver } | undefined {
  const channels = summaries.flatMap((summary) =>
    summary.entries.map((entry) => entry.execution?.channel),
  );
  const first = channels[0];
  if (
    !first?.driver ||
    !["qa-channel", "crabline", "live"].includes(first.driver) ||
    channels.some((channel) => channel?.driver !== first.driver)
  ) {
    return undefined;
  }
  return {
    ...(channels.every((channel) => channel?.id === first.id) ? { id: first.id } : {}),
    driver: first.driver as QaTransportDriver,
  };
}

type QaFlowChannelGroup = {
  channel: string | undefined;
  channelId: string | undefined;
  isolatesAdapterInstances?: boolean;
  scenarios: QaSeedScenarioWithSource[];
};

function groupQaScenariosByExecutionCell(
  scenarios: readonly QaSeedScenarioWithSource[],
  cells: readonly QaScenarioExecutionCell[],
) {
  const scenariosById = new Map<string, QaSeedScenarioWithSource[]>();
  for (const scenario of scenarios) {
    const instances = scenariosById.get(scenario.id) ?? [];
    instances.push(scenario);
    scenariosById.set(scenario.id, instances);
  }
  const positions = new Map<string, number>();
  const groups = new Map<string | undefined, QaSeedScenarioWithSource[]>();
  for (const cell of cells) {
    const channel = cell.channel ?? undefined;
    const group = groups.get(channel) ?? [];
    const key = JSON.stringify([cell.scenarioId, channel]);
    const position = positions.get(key) ?? 0;
    const scenario = scenariosById.get(cell.scenarioId)?.[position];
    if (!scenario) {
      throw new Error("execution cell has no scheduled scenario instance");
    }
    group.push(scenario);
    positions.set(key, position + 1);
    groups.set(channel, group);
  }
  return groups;
}

export async function runQaSuiteWithInfraRetry<Result>(
  run: (attempt: number) => Promise<Result>,
  maxRetries = QA_SUITE_INFRA_RETRY_LIMIT,
  signal?: AbortSignal,
  options?: {
    canRetry?: () => boolean;
    onAttemptFailure?: (error: unknown, final: boolean) => void;
  },
) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    signal?.throwIfAborted();
    try {
      return await run(attempt);
    } catch (error) {
      const retry =
        !signal?.aborted &&
        isQaSuiteInfraRetryableError(error) &&
        attempt < maxRetries &&
        options?.canRetry?.() !== false;
      // Retry admission and evidence selection share one synchronous decision;
      // a sibling cleanup failure must not leave this attempt nonterminal.
      options?.onAttemptFailure?.(error, !retry);
      if (!retry) {
        throw error;
      }
      process.stderr.write(
        `[qa-suite] infra retry ${attempt + 1}/${maxRetries}: ${formatErrorMessage(error)}\n`,
      );
    }
  }
  throw new Error("unreachable qa suite retry state");
}

async function loadQaFlowSuiteRuntime() {
  const [{ runQaFlowSuite }, { startQaLabServer: startLab }] = await Promise.all([
    import("./suite.js"),
    import("./lab-server.js"),
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
    return structuredClone(scenario);
  });
}

async function resolveQaFlowChannelGroups(
  runParams: QaSuiteRunParams | undefined,
  scenarios: readonly QaSeedScenarioWithSource[],
): Promise<QaFlowChannelGroup[]> {
  if (runParams?.adapterFactories) {
    const isolatesInstances = (channelId: string | undefined) => {
      if (!channelId || runParams.channelDriver !== "live") {
        return false;
      }
      return (
        runParams.adapterFactories?.find((factory) =>
          factory.matches({ channelId, driver: "live" }),
        )?.isolatesInstances === true
      );
    };
    const groups = groupQaScenariosByExecutionCell(
      scenarios,
      expandQaScenarioExecutionCells({
        scenarios,
        channelDriver: runParams.channelDriver ?? "qa-channel",
        channel: runParams.channelId,
        supportsChannel: (channelId) =>
          runParams.adapterFactories?.some((factory) =>
            factory.matches({ channelId, driver: "live" }),
          ) === true,
        expandChannels: runParams.expandScenarioChannels === true,
      }),
    );
    return [...groups].map(([channel, groupedScenarios]) => ({
      channel,
      channelId: channel,
      isolatesAdapterInstances: isolatesInstances(channel),
      scenarios: groupedScenarios,
    }));
  }
  if (runParams?.channelDriver !== "crabline") {
    return [
      {
        channel: runParams?.channelId,
        channelId: runParams?.channelId,
        scenarios: [...scenarios],
      },
    ];
  }
  // Package-only live lanes mount the QA harness without its dev tree. Load
  // Crabline only for Crabline-owned runs so unrelated transports stay isolated.
  const { isCrablineServerChannel, OPENCLAW_CRABLINE_DEFAULT_CHANNEL } =
    await import("@openclaw/crabline");
  if (runParams.expandScenarioChannels) {
    const groups = groupQaScenariosByExecutionCell(
      scenarios,
      expandQaScenarioExecutionCells({
        scenarios,
        channelDriver: "crabline",
        channel: runParams.channelId,
        defaultChannel: OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
        supportsChannel: isCrablineServerChannel,
        expandChannels: true,
      }),
    );
    return [...groups].map(([channel, groupedScenarios]) => ({
      channel,
      channelId: channel,
      scenarios: groupedScenarios,
    }));
  }
  const channels = resolveQaSuiteScenarioChannels({
    defaultChannel: OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
    explicitChannel: runParams.channelId,
    scenarios: [...scenarios],
  });
  const [singleChannel] = channels;
  if (channels.length === 1 && singleChannel) {
    return [
      {
        channel: singleChannel,
        channelId: singleChannel,
        scenarios: [...scenarios],
      },
    ];
  }
  // One Crabline process serves one channel. Mixed logical suites therefore
  // launch one flow partition per channel and aggregate them at this owner.
  return channels.map((channel) => ({
    channel,
    channelId: channel,
    scenarios: scenarios.filter(
      (scenario) =>
        (normalizeQaSuiteScenarioChannel(scenario) ?? OPENCLAW_CRABLINE_DEFAULT_CHANNEL) ===
        channel,
    ),
  }));
}

async function resolveSuiteExecutionPlan(
  params: QaSuiteRunParams | undefined,
): Promise<QaSuiteExecutionPlan> {
  const scenarioIds = params?.scenarioIds ?? [];
  if (scenarioIds.length === 0) {
    return { kind: "flow", expectedCells: [], scenarios: [] };
  }
  const selectedScenarios = resolveRequestedScenarios({
    scenarioIds,
    scenarios: params?.scenarioDefinitions ?? readQaBootstrapScenarioCatalog().scenarios,
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
  const channelGroups = (await resolveQaFlowChannelGroups(params, flowScenarios)).filter(
    (group) => group.scenarios.length > 0,
  );
  const expectedCells = [
    ...channelGroups.flatMap((group) =>
      expandQaScenarioExecutionCells({
        scenarios: group.scenarios,
        channelDriver: params?.channelDriver ?? "qa-channel",
        channel: group.channel,
        expandChannels: false,
      }),
    ),
    ...expandQaScenarioExecutionCells({
      scenarios: [...testFileScenariosByKind.values()].flat(),
      channelDriver: params?.channelDriver ?? "qa-channel",
      expandChannels: false,
    }),
  ];
  const requiresFlowPartitions =
    channelGroups.length > 1 ||
    channelGroups.some(
      (group) => group.channelId !== undefined && group.channelId !== params?.channelId,
    ) ||
    flowScenarios.some(
      (scenario) => scenario.execution.kind === "flow" && scenario.execution.runtime !== undefined,
    ) ||
    (flowScenarios.length > 1 && flowScenarios.some(scenarioRequiresIsolatedQaSuiteWorker));
  if (testFileScenariosByKind.size === 0 && !requiresFlowPartitions) {
    return { kind: "flow", expectedCells, scenarios: selectedScenarios };
  }
  return {
    kind: "unified",
    channelGroups,
    expectedCells,
    scenarios: selectedScenarios,
    testFileScenariosByKind,
  };
}

async function runQaTestFileSuiteFromRuntime(params: {
  env?: NodeJS.ProcessEnv;
  onResultCommitted?: Parameters<typeof runQaTestFileScenarios>[0]["onResultCommitted"];
  preparedDockerEvidence?: dockerBatch.QaPreparedDockerEvidence;
  kind: QaTestFileExecutionKind;
  runParams: QaSuiteRunParams | undefined;
  scenarios: readonly QaTestFileScenario[];
}): Promise<QaTestFileScenarioRunResult> {
  const runParams = params.runParams;
  rejectFlowOnlySuiteOptionsForUnifiedRun(runParams);
  const repoRoot = path.resolve(runParams?.repoRoot ?? process.cwd());
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, runParams?.outputDir);
  const providerMode = normalizeQaProviderMode(runParams?.providerMode ?? DEFAULT_QA_PROVIDER_MODE);
  const primaryModel = runParams?.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  return await runQaTestFileScenarios({
    signal: runParams?.signal,
    forwardParentSignals: runParams?.forwardParentSignals,
    evidenceMode: runParams?.evidenceMode,
    evidenceAnchors: runParams?.evidenceAnchors,
    evidenceContinuation: runParams?.evidenceContinuation,
    onEvidence: runParams?.onEvidence,
    onScenarioStarted: runParams?.onScenarioStarted,
    onResultCommitted: params.onResultCommitted,
    preparedDockerEvidence: params.preparedDockerEvidence,
    ...(params.env
      ? { env: params.env, envMode: "replace" as const }
      : params.kind !== "script"
        ? {
            // The owning QA process already loaded the prepared runtime. Native
            // child setup must not clean or rebuild those files under live gateways.
            env: { OPENCLAW_E2E_USE_PREBUILT_DIST: "1" },
          }
        : {}),
    ...(runParams?.failFast ? { failFast: true } : {}),
    ...(shouldLogQaSuiteProgress()
      ? { progress: (message: string) => writeQaSuiteProgress(true, message) }
      : {}),
    repoRoot,
    outputDir,
    providerMode,
    primaryModel,
    scenarios: params.scenarios,
    writeEvidenceFile: runParams?.writeEvidenceFile,
  });
}

async function prepareQaSuiteNativeRuntime(repoRoot: string, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const argv = [
    process.execPath,
    "--import",
    "tsx",
    "scripts/tsdown-build.mts",
    "--config",
    "tsdown.ai.config.ts",
  ];
  const result = await withCommandProcessScope(
    () => runPluginCommandWithTimeout({ argv, cwd: repoRoot, timeoutMs: 20 * 60_000 }),
    signal,
  ).catch((error: unknown) => {
    // The SDK returns ordinary command failures as results. Scope rejection
    // means process cleanup is unconfirmed and must keep Lab admission closed.
    throw new QaSuiteCleanupError([error], "QA suite runtime preparation cleanup failed");
  });
  signal?.throwIfAborted();
  if (result.code !== 0) {
    throw new Error(`QA suite runtime preparation failed (${argv.join(" ")}): ${result.stderr}`);
  }
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
  maxPartitions = MAX_SHARED_FLOW_PARTITIONS,
) {
  const partitionCount = Math.min(
    Math.max(1, Math.floor(concurrency)),
    Math.max(1, Math.floor(maxPartitions)),
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

async function readQaSuiteEvidenceSummary(evidencePath: string) {
  return validateQaEvidenceSummaryJson(JSON.parse(await fs.readFile(evidencePath, "utf8")));
}

function hasCredentialPoolUnavailableCode(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    ("code" in error && CREDENTIAL_POOL_UNAVAILABLE_CODES.has(String(error.code))) ||
    hasCredentialPoolUnavailableCode(error.cause)
  );
}

function isChannelCredentialPoolUnavailable(
  error: unknown,
  channelId: string | undefined,
): boolean {
  if (!channelId || !(error instanceof Error)) {
    return false;
  }
  return (
    (error.message.startsWith(`failed to create QA transport live:${channelId}:`) &&
      hasCredentialPoolUnavailableCode(error.cause)) ||
    isChannelCredentialPoolUnavailable(error.cause, channelId)
  );
}

function testFileScenarioResultToSuiteScenario(
  result: QaTestFileScenarioRunResult["results"][number],
  repoRoot: string,
): QaSuiteScenarioResult {
  const suiteStatus =
    result.status === "pass" ? "pass" : result.status === "skipped" ? "skip" : "fail";
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
    evidenceOccurrenceId: result.evidenceOccurrenceId,
    details,
    steps: [
      {
        name: `Run ${result.scenario.execution.kind} test file`,
        status: suiteStatus,
        details,
      },
    ],
  };
}

async function writeUnifiedQaSuiteArtifacts(params: {
  alternateModel: string;
  channel?: string;
  channelDriver?: QaTransportDriver;
  concurrency: number;
  evidence: QaEvidenceSummaryJson;
  fastMode: boolean;
  finishedAt: Date;
  outputDir: string;
  primaryModel: string;
  providerMode: ReturnType<typeof normalizeQaProviderMode>;
  runtimePair: QaSuiteRunParams["runtimePair"];
  scenarioIds: readonly string[];
  scenarios: readonly QaSuiteScenarioResult[];
  startedAt: Date;
}) {
  const evidencePath = path.join(params.outputDir, QA_EVIDENCE_FILENAME);
  const reportPath = path.join(params.outputDir, "qa-suite-report.md");
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  const report = renderQaMarkdownReport({
    title: "OpenClaw QA Scenario Suite",
    finishedAt: params.finishedAt,
    scenarios: [...params.scenarios],
    startedAt: params.startedAt,
  });
  const summary = buildQaSuiteSummaryJson({
    ...params,
    scenarios: [...params.scenarios],
  }) satisfies QaSuiteSummaryJson;
  await publishQaSuiteArtifactFiles({
    outputDir: params.outputDir,
    files: [
      { filePath: evidencePath, content: `${JSON.stringify(params.evidence, null, 2)}\n` },
      { filePath: reportPath, content: report },
      { filePath: summaryPath, content: `${JSON.stringify(summary, null, 2)}\n` },
    ],
  });
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
}): Promise<QaUnifiedSuiteResult & { observedCells: QaScenarioExecutionCell[] }> {
  if (params.plan.testFileScenariosByKind.size > 0) {
    rejectFlowOnlySuiteOptionsForUnifiedRun(params.runParams);
  }
  const startedAt = new Date();
  const cleanupFailures = new Set<QaSuiteCleanupError>();
  const repoRoot = path.resolve(params.runParams?.repoRoot ?? process.cwd());
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, params.runParams?.outputDir);
  await invalidateQaSuiteArtifactGeneration(outputDir);
  const adapterFactories = await prepareQaTransportAdapterFactories({
    factories: params.runParams?.adapterFactories,
    driver: params.runParams?.channelDriver,
    cells: params.plan.expectedCells,
  });
  // Only an explicitly selected single flow may replace the unified suite's mock default.
  const [selectedScenario] = params.plan.scenarios;
  const selectedProviderMode =
    params.runParams?.providerMode === undefined &&
    params.runParams?.scenarioIds?.length === 1 &&
    params.plan.scenarios.length === 1 &&
    selectedScenario?.execution.kind === "flow"
      ? resolveQaScenarioRequiredProviderMode(selectedScenario)
      : undefined;
  const providerMode = normalizeQaProviderMode(
    params.runParams?.providerMode ?? selectedProviderMode ?? DEFAULT_QA_PROVIDER_MODE,
  );
  const progress = params.runParams?.lab
    ? createQaSuiteProgressController({
        lab: params.runParams.lab,
        scenarios: params.plan.scenarios,
        startedAt: startedAt.toISOString(),
      })
    : undefined;
  progress?.start();
  const { primaryModel, alternateModel } = resolveQaRuntimeModelPair({
    providerMode,
    primaryModel: params.runParams?.primaryModel,
    alternateModel: params.runParams?.alternateModel,
  });
  const fastMode =
    typeof params.runParams?.fastMode === "boolean"
      ? params.runParams.fastMode
      : isQaFastModeEnabled({ primaryModel, alternateModel });
  const transportId = normalizeQaTransportId(params.runParams?.transportId);
  const defaultConcurrency =
    params.runParams?.channelDriver === "crabline"
      ? 1
      : defaultQaSuiteConcurrencyForTransport(transportId);
  const failFast = params.runParams?.failFast === true;
  const concurrency = failFast
    ? 1
    : normalizeQaSuiteConcurrency(
        params.runParams?.concurrency,
        params.plan.scenarios.length,
        defaultConcurrency,
      );

  const observedCellsByKey = new Map<string, QaScenarioExecutionCell>();
  const recordObservedScenarios = (
    scenarios: readonly QaSeedScenarioWithSource[],
    channel?: string,
  ) => {
    for (const cell of expandQaScenarioExecutionCells({
      scenarios,
      channelDriver: params.runParams?.channelDriver ?? "qa-channel",
      channel,
      expandChannels: false,
    })) {
      observedCellsByKey.set(JSON.stringify(cell), cell);
    }
  };
  const sharedFlowPartitionTasks: QaUnifiedPartitionTask[] = [];
  const isolatedFlowPartitionTasks: QaUnifiedPartitionTask[] = [];
  const testFilePartitionTasks: QaUnifiedPartitionTask[] = [];
  const serialScriptPartitionTasks: QaUnifiedPartitionTask[] = [];
  const parallelScriptPartitionTasks: QaUnifiedPartitionTask[] = [];
  const unavailableChannelCredentialDetails = new Map<string, string>();
  const launch = await captureQaEvidenceLaunchIdentity(repoRoot);
  const evidenceOwners: QaPartitionEvidenceOwner[] = [];
  const scenarioOrder = new Map(params.plan.scenarios.map((scenario, index) => [scenario, index]));
  const scheduledAnchorOrder = new Map<string, number>();
  const progressEntries = (entries: QaUnifiedPartitionResult["scenarioResults"]) =>
    entries.flatMap(({ instanceId, result }) => {
      const scenarioIndex =
        instanceId === undefined ? undefined : scheduledAnchorOrder.get(instanceId);
      return scenarioIndex === undefined ? [] : [{ scenarioIndex, result }];
    });
  const createOwner = (
    scenarios: readonly QaSeedScenarioWithSource[],
    channel: string | null,
    partitionOutputDir: string,
    executionChannel?: string,
    formatRestoredResult?: (result: QaSuiteScenarioResult) => QaSuiteScenarioResult,
  ) => {
    const owner = createQaPartitionEvidenceOwner({
      scenarios,
      channel,
      launch,
      outputDir: partitionOutputDir,
      repoRoot,
      evidenceMode: params.runParams?.evidenceMode,
      formatRestoredResult,
      primaryModel,
      providerMode,
      onScenarioStarted: (instanceId) => {
        const scenario = params.plan.scenarios[scheduledAnchorOrder.get(instanceId)!];
        if (!scenario) {
          throw new Error("partition dispatch has no scheduled instance");
        }
        // Transport fallback identifies evidence custody, not the planned lane.
        recordObservedScenarios([scenario], executionChannel);
        params.runParams?.onScenarioStarted?.(instanceId);
      },
    });
    for (const [index, anchor] of owner.anchors.entries()) {
      scheduledAnchorOrder.set(anchor.id, scenarioOrder.get(scenarios[index]!)!);
    }
    evidenceOwners.push(owner);
    return owner;
  };
  let preparedScriptEnv: Readonly<NodeJS.ProcessEnv> | undefined;
  let preparedDockerEvidence: dockerBatch.QaPreparedDockerEvidence | undefined;
  if (params.plan.channelGroups.length > 0) {
    const channelGroups = params.plan.channelGroups;
    const runFlowSuite = await loadQaFlowSuiteRuntime();
    for (const channelGroup of channelGroups) {
      const formatScenarioResult = (result: QaSuiteScenarioResult) =>
        params.runParams?.expandScenarioChannels && channelGroup.channel
          ? { ...result, name: `${result.name} [${channelGroup.channel}]` }
          : result;
      const sharedFlowScenarios = channelGroup.scenarios.filter(
        (scenario) => !scenarioRequiresIsolatedQaSuiteWorker(scenario),
      );
      const isolatedFlowScenarios = channelGroup.scenarios.filter(
        scenarioRequiresIsolatedQaSuiteWorker,
      );
      const runtimeFlowScenarios = isolatedFlowScenarios.flatMap((scenario) =>
        scenario.execution.kind === "flow" && scenario.execution.runtime
          ? [{ runtime: scenario.execution.runtime, scenario }]
          : [],
      );
      const runtimeScenarioSet = new Set(runtimeFlowScenarios.map(({ scenario }) => scenario));
      const ordinaryIsolatedFlowScenarios = isolatedFlowScenarios.filter(
        (scenario) => !runtimeScenarioSet.has(scenario),
      );
      const channelId = channelGroup.channelId;
      const usesContributedChannelDriver = Boolean(
        channelId &&
        params.runParams?.channelDriver === "live" &&
        adapterFactories?.find((factory) => factory.matches({ channelId, driver: "live" })),
      );
      // Isolated adapters may use the caller's full suite budget; every partition
      // still has weight one in the global scheduler below.
      // A rejected worker cannot return its completed prefix or active scenario.
      // Single-scenario fail-fast tasks keep retries and failure evidence attributable.
      const sharedFlowPartitions = failFast
        ? sharedFlowScenarios.map((scenario) => [scenario])
        : partitionSharedFlowScenarios(
            sharedFlowScenarios,
            usesContributedChannelDriver && !channelGroup.isolatesAdapterInstances
              ? 1
              : concurrency,
            channelGroup.isolatesAdapterInstances ? concurrency : MAX_SHARED_FLOW_PARTITIONS,
          );
      // Channel-driver flow workers each launch a gateway plus transport harness.
      // Serializing their isolated workers keeps state-mutating smoke checks from
      // flaking under concurrent child gateways while preserving non-driver speed.
      const channelDriverFlowRequiresExclusiveWorkers =
        (params.runParams?.channelDriver === "crabline" || usesContributedChannelDriver) &&
        !channelGroup.isolatesAdapterInstances;
      const isolatedFlowConcurrencyLimit = channelDriverFlowRequiresExclusiveWorkers
        ? 1
        : MAX_ISOLATED_FLOW_CONCURRENCY;
      const isolatedFlowConcurrency = Math.min(
        concurrency,
        isolatedFlowConcurrencyLimit,
        ordinaryIsolatedFlowScenarios.length,
      );
      const isolatedFlowPartitions =
        isolatedFlowConcurrency === 1 && ordinaryIsolatedFlowScenarios.length > 1
          ? ordinaryIsolatedFlowScenarios.map((scenario, index) => ({
              kind: `isolated-${index + 1}`,
              scenarios: [scenario],
              concurrency: 1,
            }))
          : [
              {
                kind: "isolated",
                scenarios: ordinaryIsolatedFlowScenarios,
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
        ...runtimeFlowScenarios.map(({ runtime, scenario }, index) => ({
          kind: `runtime-${runtime}-${index + 1}`,
          scenarios: [scenario],
          concurrency: 1,
        })),
      ].filter((partition) => partition.scenarios.length > 0);
      for (const partition of flowPartitions) {
        const isolatedPartition =
          partition.kind === "isolated" || partition.kind.startsWith("isolated-");
        const partitionName = [
          channelGroups.length > 1 ? channelGroup.channel : undefined,
          flowPartitions.length > 1 ? partition.kind : undefined,
        ]
          .filter((part): part is string => Boolean(part))
          .join("-");
        const taskChannelId = channelGroup.channelId ?? channelGroup.channel ?? transportId;
        const partitionOutputDir = partitionName
          ? flowSuitePartitionOutputDir(outputDir, partitionName)
          : suitePartitionOutputDir(outputDir, "flow");
        const owner = createOwner(
          partition.scenarios,
          taskChannelId,
          partitionOutputDir,
          channelGroup.channel,
          formatScenarioResult,
        );
        const buildCredentialUnavailableResult = (details: string): QaUnifiedPartitionResult => {
          const blockedResults = owner.failure(details, true, "blocked");
          return {
            evidenceSummaries: [owner.summary()],
            scenarioResults: blockedResults.map(({ scenarioId, instanceId, result }) => ({
              scenarioId,
              instanceId,
              result: {
                ...formatScenarioResult(result),
                steps: [{ name: "Acquire channel credential", status: "fail", details }],
              },
            })),
            startedInstanceIds: owner.startedInstanceIds(),
          };
        };
        const task = {
          channel: channelGroup.channel,
          channelId: taskChannelId,
          // One channel's credential and Gateway state stay serial unless each adapter create()
          // owns an isolated runtime. Distinct channels may always run together.
          exclusiveKey: channelDriverFlowRequiresExclusiveWorkers
            ? `channel:${channelGroup.channel ?? channelGroup.channelId ?? "default"}`
            : undefined,
          scenarios: partition.scenarios,
          evidenceOwners: [owner],
          weight: partition.concurrency,
          run: async () => {
            const unavailableDetails = channelGroup.channelId
              ? unavailableChannelCredentialDetails.get(channelGroup.channelId)
              : undefined;
            if (unavailableDetails) {
              return buildCredentialUnavailableResult(unavailableDetails);
            }
            const result = await runFlowSuite({
              ...params.runParams,
              ...owner.input(),
              adapterFactories,
              ...(progress
                ? {
                    lab: progress.createPartitionLab(
                      partition.scenarios.map((scenario) => scenarioOrder.get(scenario)!),
                    ),
                  }
                : {}),
              outputDir: partitionOutputDir,
              writeEvidenceFile: false,
              providerMode,
              primaryModel,
              alternateModel,
              fastMode,
              forcedRuntime:
                partition.scenarios.length === 1 &&
                partition.scenarios[0]?.execution.kind === "flow"
                  ? (partition.scenarios[0].execution.runtime ?? params.runParams?.forcedRuntime)
                  : params.runParams?.forcedRuntime,
              concurrency: partition.concurrency,
              channelId: channelGroup.channelId,
              workerStartStaggerMs: isolatedPartition
                ? (params.runParams?.workerStartStaggerMs ??
                  resolveQaSuiteWorkerStartStaggerMs(
                    partition.concurrency,
                    process.env,
                    ISOLATED_FLOW_WORKER_START_STAGGER_MS,
                  ))
                : params.runParams?.workerStartStaggerMs,
              scenarioIds: partition.scenarios.map((scenario) => scenario.id),
            }).catch((error: unknown) => {
              if (!isChannelCredentialPoolUnavailable(error, channelGroup.channelId)) {
                throw error;
              }
              // Preserve other channels' evidence, but keep the suite failed: maturity
              // docs must not publish until every required channel can run.
              const details = `channel credential unavailable: ${formatErrorMessage(error)}`;
              if (channelDriverFlowRequiresExclusiveWorkers && channelGroup.channelId) {
                unavailableChannelCredentialDetails.set(channelGroup.channelId, details);
              }
              return buildCredentialUnavailableResult(details);
            });
            if ("evidenceSummaries" in result) {
              return result;
            }
            const scenarioResults: QaUnifiedPartitionResult["scenarioResults"] = [];
            const childEvidence =
              result.evidence ?? (await readQaSuiteEvidenceSummary(result.evidencePath));
            const childAnchors =
              childEvidence.schemaVersion === 3
                ? resolveQaEvidenceContainment(childEvidence.occurrences, childEvidence.entries)
                    .rootInstances
                : [];
            for (const [resultIndex, scenarioResult] of result.scenarios.entries()) {
              const index =
                childEvidence.schemaVersion === 3
                  ? childAnchors.findIndex(
                      (anchor) =>
                        anchor.scenario?.kind === "instance" &&
                        anchor.scenario.resultOccurrenceId === scenarioResult.evidenceOccurrenceId,
                    )
                  : resultIndex;
              const scenario = partition.scenarios[index];
              if (!scenario) {
                throw new Error("flow result has no admitted scheduled instance");
              }
              scenarioResults.push({
                scenarioId: scenario.id,
                result: formatScenarioResult(scenarioResult),
              });
            }
            const normalized = owner.complete(
              childEvidence,
              scenarioResults,
              result.startedScenarioIds,
              result.startedScenarioInstanceIds,
            );
            return {
              evidenceSummaries: [],
              scenarioResults: normalized,
              startedInstanceIds: owner.startedInstanceIds(),
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
  }
  const createTestFilePartitionTask = (
    scenariosByKind: ReadonlyMap<QaTestFileExecutionKind, QaTestFileScenario[]>,
  ) => {
    const taskScenarios = [...scenariosByKind.values()].flat();
    const owners = new Map(
      [...scenariosByKind].map(([kind, scenarios]) => [
        kind,
        createOwner(scenarios, null, suitePartitionOutputDir(outputDir, kind)),
      ]),
    );
    return {
      channelId: transportId,
      scenarios: taskScenarios,
      weight: 1,
      evidenceOwners: [...owners.values()],
      run: async () => {
        const testFileScenarioResults: QaUnifiedPartitionResult["scenarioResults"] = [];
        const testFileStartedInstanceIds: string[] = [];
        for (const [kind, testFileScenarios] of scenariosByKind) {
          if (params.runParams?.signal?.aborted || cleanupFailures.size > 0) {
            break;
          }
          const owner = owners.get(kind)!;
          progress?.markRunning(
            (failFast ? testFileScenarios.slice(0, 1) : testFileScenarios).map((scenario) =>
              scenarioOrder.get(scenario)!,
            ),
          );
          const result = await runQaTestFileSuiteFromRuntime({
            env: kind === "script" ? preparedScriptEnv : undefined,
            onResultCommitted: (scenarioResult) =>
              owner.recordResult(testFileScenarioResultToSuiteScenario(scenarioResult, repoRoot)),
            preparedDockerEvidence: kind === "script" ? preparedDockerEvidence : undefined,
            kind,
            runParams: {
              ...params.runParams,
              ...owner.input(),
              adapterFactories,
              outputDir: suitePartitionOutputDir(outputDir, kind),
              writeEvidenceFile: false,
              providerMode,
              primaryModel,
              scenarioIds: testFileScenarios.map((scenario) => scenario.id),
            },
            scenarios: testFileScenarios,
          });
          const scenarioResults = result.results.map((scenarioResult) => ({
            scenarioId: scenarioResult.scenario.id,
            result: testFileScenarioResultToSuiteScenario(scenarioResult, repoRoot),
          }));
          const normalized = owner.complete(
            result.evidence,
            scenarioResults,
            // A legacy fail-fast native task is dispatched with one scenario.
            // Its omitted result is a failure; a shared label cannot prove that
            // any further scheduled instance started.
            result.evidence.schemaVersion === 2 && failFast && testFileScenarios.length === 1
              ? [testFileScenarios[0]!.id]
              : result.results.map((item) => item.scenario.id),
          );
          testFileStartedInstanceIds.push(...owner.startedInstanceIds());
          const shouldStopNativeKinds =
            failFast && normalized.some((item) => item.result.status !== "pass");
          testFileScenarioResults.push(...normalized);
          progress?.recordResults(progressEntries(normalized));
          if (shouldStopNativeKinds) {
            break;
          }
        }
        return {
          evidenceSummaries: [],
          scenarioResults: testFileScenarioResults,
          startedInstanceIds: testFileStartedInstanceIds,
        };
      },
    } satisfies QaUnifiedPartitionTask;
  };
  const concurrentTestFileScenariosByKind = new Map(
    [...params.plan.testFileScenariosByKind].filter(([kind]) => kind !== "script"),
  );
  if (concurrentTestFileScenariosByKind.size > 0) {
    if (failFast) {
      for (const [kind, scenarios] of concurrentTestFileScenariosByKind) {
        for (const scenario of scenarios) {
          testFilePartitionTasks.push(createTestFilePartitionTask(new Map([[kind, [scenario]]])));
        }
      }
    } else {
      testFilePartitionTasks.push(createTestFilePartitionTask(concurrentTestFileScenariosByKind));
    }
  }
  const scriptScenarios = params.plan.testFileScenariosByKind
    .get("script")
    ?.filter((scenario) => scenario.execution.kind === "script");
  if (scriptScenarios?.length) {
    const isParallelSafeScript = (scenario: QaTestFileScenario) =>
      scenario.execution.kind === "script" && scenario.execution.parallelSafe === true;
    if (failFast) {
      for (const scenario of scriptScenarios) {
        serialScriptPartitionTasks.push(
          createTestFilePartitionTask(new Map([["script", [scenario]]])),
        );
      }
    } else {
      const serialScenarios = scriptScenarios.filter((scenario) => !isParallelSafeScript(scenario));
      if (serialScenarios.length > 0) {
        serialScriptPartitionTasks.push(
          createTestFilePartitionTask(new Map([["script", serialScenarios]])),
        );
      }
      for (const scenario of scriptScenarios) {
        if (isParallelSafeScript(scenario)) {
          parallelScriptPartitionTasks.push(
            createTestFilePartitionTask(new Map([["script", [scenario]]])),
          );
        }
      }
    }
  }
  const concurrentPartitionTasks = [
    ...sharedFlowPartitionTasks,
    ...testFilePartitionTasks,
    ...isolatedFlowPartitionTasks,
  ];
  const partitionFailed = (partition: QaUnifiedPartitionResult) => {
    if (partition.scenarioResults.some((scenario) => scenario.result.status !== "pass")) {
      return true;
    }
    const returnedInstances = new Set(
      partition.scenarioResults.map((scenario) => scenario.instanceId),
    );
    return partition.startedInstanceIds.some((id) => !returnedInstances.has(id));
  };
  const capturePartitionFailure = (
    task: Pick<QaUnifiedPartitionTask, "channelId" | "scenarios" | "evidenceOwners">,
    error: unknown,
    started = true,
    final = true,
  ): QaUnifiedPartitionResult => {
    if (error instanceof QaSuiteCleanupError) {
      cleanupFailures.add(error);
    }
    const details = `suite partition failed: ${formatErrorMessage(error)}`;
    const scenarioResults = task.evidenceOwners.flatMap((owner) =>
      owner.active || !started ? owner.failure(details, final) : [],
    );
    return {
      evidenceSummaries: [],
      scenarioResults,
      startedInstanceIds: started
        ? task.evidenceOwners.flatMap((owner) => owner.startedInstanceIds())
        : [],
    };
  };
  const runPartitionTasks = async (tasks: readonly QaUnifiedPartitionTask[], maxWeight: number) => {
    const isCancellation = (error: unknown) =>
      params.runParams?.signal?.aborted === true &&
      error === params.runParams.signal.reason &&
      !(error instanceof QaSuiteCleanupError);
    // Retry inside the scheduled task so its weight and exclusive key stay held;
    // one failed channel must not replay partitions that already completed.
    const retryingTasks = tasks.map((task) => ({
      ...task,
      run: async () => {
        let failure: QaUnifiedPartitionResult | undefined;
        try {
          return await runQaSuiteWithInfraRetry(
            () => task.run(),
            QA_SUITE_INFRA_RETRY_LIMIT,
            params.runParams?.signal,
            {
              canRetry: () => cleanupFailures.size === 0,
              onAttemptFailure: (error, final) => {
                if (!isCancellation(error)) {
                  failure = capturePartitionFailure(task, error, true, final);
                }
              },
            },
          );
        } catch (error) {
          if (isCancellation(error)) {
            // A cancelled retry may never return its committed prefix. The
            // terminal owner restores selected results after every task joins.
            return {
              evidenceSummaries: [],
              scenarioResults: [],
              startedInstanceIds: task.evidenceOwners.flatMap((owner) =>
                owner.startedInstanceIds(),
              ),
            };
          }
          // Failed partitions still own durable failure evidence; rejecting here would
          // discard completed siblings and prevent the unified artifacts from existing.
          if (!failure) {
            throw error;
          }
          return failure;
        }
      },
    }));
    return failFast
      ? await mapQaSuiteWithConcurrency(retryingTasks, 1, (task) => task.run(), {
          signal: params.runParams?.signal,
          canStart: () => cleanupFailures.size === 0,
          shouldStop: partitionFailed,
        })
      : await runWeightedQaSuiteTasks(retryingTasks, maxWeight, {
          signal: params.runParams?.signal,
          canStart: () => cleanupFailures.size === 0,
        });
  };
  // Native children opt out of their destructive global build only after this
  // scheduler has established the shared runtime they consume concurrently.
  let nativePreparationFailure: QaUnifiedPartitionResult[] | undefined;
  if (concurrentTestFileScenariosByKind.has("vitest")) {
    try {
      await prepareQaSuiteNativeRuntime(repoRoot, params.runParams?.signal);
    } catch (error) {
      nativePreparationFailure = concurrentPartitionTasks.map((task) =>
        capturePartitionFailure(task, error, false),
      );
      progress?.recordResults(
        progressEntries(nativePreparationFailure.flatMap((partition) => partition.scenarioResults)),
      );
    }
  }
  const concurrentPartitionResults =
    nativePreparationFailure ?? (await runPartitionTasks(concurrentPartitionTasks, concurrency));
  const concurrentFailed =
    nativePreparationFailure !== undefined ||
    cleanupFailures.size > 0 ||
    (failFast && concurrentPartitionResults.some(partitionFailed));
  let scriptPreparationFailure: QaUnifiedPartitionResult | undefined;
  if (
    !params.runParams?.signal?.aborted &&
    !concurrentFailed &&
    scriptScenarios?.some(dockerBatch.dockerLaneName)
  ) {
    try {
      preparedScriptEnv = await dockerBatch.prepareDockerE2eEnvironment({
        env: process.env,
        outputDir,
        repoRoot,
        scenarios: scriptScenarios,
        runCommand: (command) =>
          runQaScenarioCommandLifecycle({
            ...command,
            signal: params.runParams?.signal,
            forwardParentSignals: params.runParams?.forwardParentSignals,
          }),
        onPrepared: (evidence) => {
          preparedDockerEvidence = evidence;
        },
      });
    } catch (error) {
      if (error instanceof QaSuiteCleanupError) {
        cleanupFailures.add(error);
      }
      scriptPreparationFailure = capturePartitionFailure(
        {
          channelId: transportId,
          scenarios: scriptScenarios,
          evidenceOwners: [...serialScriptPartitionTasks, ...parallelScriptPartitionTasks].flatMap(
            (task) => task.evidenceOwners,
          ),
        },
        new Error(`Docker candidate preparation failed: ${formatErrorMessage(error)}`),
        false,
      );
      progress?.recordResults(progressEntries(scriptPreparationFailure.scenarioResults));
    }
  }
  // Unmarked scripts may rebuild shared checkout state. Run them exclusively
  // after every flow and native partition settles, then start only audited peers.
  const serialScriptPartitionResults =
    concurrentFailed || scriptPreparationFailure
      ? []
      : await runPartitionTasks(serialScriptPartitionTasks, 1);
  const parallelScriptPartitionResults =
    concurrentFailed ||
    scriptPreparationFailure ||
    (failFast && serialScriptPartitionResults.some(partitionFailed))
      ? []
      : await runPartitionTasks(
          parallelScriptPartitionTasks,
          Math.min(concurrency, MAX_PARALLEL_SCRIPT_CONCURRENCY),
        );
  const partitionResults = [
    ...concurrentPartitionResults,
    ...(scriptPreparationFailure ? [scriptPreparationFailure] : []),
    ...serialScriptPartitionResults,
    ...parallelScriptPartitionResults,
  ];
  try {
    const interruption = describeQaSuiteInterruption(
      params.runParams?.signal,
      cleanupFailures.values().next().value,
    );
    if (interruption) {
      // Admission has closed and every started partition has joined. Restore
      // committed results and complete only unresolved, unexecuted instances.
      const reportedIds = new Set(
        partitionResults.flatMap((partition) =>
          partition.scenarioResults.map(({ result }) => result.evidenceOccurrenceId),
        ),
      );
      const scenarioResults: QaUnifiedPartitionResult["scenarioResults"] = [];
      for (const owner of evidenceOwners) {
        scenarioResults.push(...(await owner.finalizeInterrupted(interruption, reportedIds)));
      }
      partitionResults.push({
        evidenceSummaries: [],
        scenarioResults,
        startedInstanceIds: [],
      });
    }
    const finishedAt = new Date();
    const mergedEvidence = mergeQaEvidenceSummaries({
      evidenceSummaries: evidenceOwners.map((owner) => owner.summary()),
      generatedAt: finishedAt.toISOString(),
    });
    if (mergedEvidence.schemaVersion !== 3) {
      throw new Error("aggregate evidence requires its captured invocation owners");
    }
    const orderedAnchors = resolveQaEvidenceContainment(
      mergedEvidence.occurrences,
      mergedEvidence.entries,
    ).rootInstances.toSorted(
      (left, right) => scheduledAnchorOrder.get(left.id)! - scheduledAnchorOrder.get(right.id)!,
    );
    const evidence = {
      ...mergedEvidence,
      occurrences: [
        ...orderedAnchors,
        ...mergedEvidence.occurrences.filter(
          (occurrence) => !scheduledAnchorOrder.has(occurrence.id),
        ),
      ],
    };
    const channel = summarizeQaEvidenceChannel([evidence]);
    const resultsByOccurrence = new Map(
      partitionResults.flatMap((partition) =>
        partition.scenarioResults.map(
          ({ result }) => [result.evidenceOccurrenceId, result] as const,
        ),
      ),
    );
    const scenarios = orderedAnchors.flatMap((anchor) => {
      const id = anchor.scenario?.kind === "instance" ? anchor.scenario.resultOccurrenceId : null;
      if (id === null) {
        return [];
      }
      const result = resultsByOccurrence.get(id);
      if (!result) {
        throw new Error("aggregate selected observation has no returned result");
      }
      return [result];
    });
    const unifiedResult = await writeUnifiedQaSuiteArtifacts({
      alternateModel,
      channel: channel?.id,
      channelDriver: channel?.driver,
      concurrency,
      evidence,
      fastMode,
      finishedAt,
      outputDir,
      primaryModel,
      providerMode,
      runtimePair: params.runParams?.runtimePair,
      scenarioIds: params.plan.scenarios.map((scenario) => scenario.id),
      scenarios,
      startedAt,
    });
    const resultsByIndex = new Map<number, QaSuiteScenarioResult[]>();
    for (const { scenarioIndex, result } of progressEntries(
      partitionResults.flatMap((partition) => partition.scenarioResults),
    )) {
      const prior = resultsByIndex.get(scenarioIndex) ?? [];
      prior.push(result);
      resultsByIndex.set(scenarioIndex, prior);
    }
    const progressResults = [...resultsByIndex].map(([scenarioIndex, results]) => ({
      scenarioIndex,
      result: {
        name: params.plan.scenarios[scenarioIndex]!.title,
        status: results.some((result) => result.status === "fail")
          ? ("fail" as const)
          : results.some((result) => result.status === "skip")
            ? ("skip" as const)
            : ("pass" as const),
        steps: results.flatMap((result) => result.steps),
      },
    }));
    progress?.complete(progressResults, finishedAt.toISOString());
    params.runParams?.lab?.setLatestReport({
      outputPath: unifiedResult.reportPath,
      markdown: unifiedResult.report,
      generatedAt: finishedAt.toISOString(),
    });
    if (cleanupFailures.size > 0) {
      throw new QaSuiteCleanupError(
        [...cleanupFailures],
        `QA suite cleanup failed: ${[...cleanupFailures].map(formatErrorMessage).join("; ")}`,
      );
    }
    return {
      ...unifiedResult,
      observedCells: [...observedCellsByKey.values()].toSorted((left, right) =>
        JSON.stringify(left).localeCompare(JSON.stringify(right)),
      ),
    };
  } catch (error) {
    if (cleanupFailures.size > 0 && !(error instanceof QaSuiteCleanupError)) {
      throw new QaSuiteCleanupError(
        [...cleanupFailures, error],
        `QA cleanup and terminal publication failed: ${formatErrorMessage(error)}`,
      );
    }
    throw error;
  }
}

export async function runQaSuite(...args: [QaSuiteRunParams?]): Promise<QaSuiteRuntimeResult> {
  const runParams = args[0];
  runParams?.signal?.throwIfAborted();
  rejectRemovedQaChannelDriverSelection(runParams);
  const plan = await resolveSuiteExecutionPlan(runParams);
  runParams?.signal?.throwIfAborted();
  if (plan.kind === "unified") {
    const { observedCells, ...result } = await runUnifiedQaSuite({
      runParams,
      plan,
    });
    return {
      executionKind: "suite",
      expectedCells: plan.expectedCells,
      observedCells,
      result,
    };
  }
  const outputDir = await resolveQaSuiteOutputDir(
    path.resolve(runParams?.repoRoot ?? process.cwd()),
    runParams?.outputDir,
  );
  let continuation = runParams?.evidenceContinuation;
  const startedInstanceIds = new Set<string>();
  const result = await runQaSuiteWithInfraRetry(
    () =>
      runQaFlowSuiteFromRuntime({
        ...runParams,
        outputDir,
        ...(continuation
          ? {
              evidenceAnchors: resolveQaEvidenceContainment(
                continuation.occurrences,
                continuation.entries,
              ).rootInstances,
              evidenceContinuation: continuation,
            }
          : {}),
        onEvidence: (summary) => {
          // Only this invocation's callback supplies retry custody. A suite-wide
          // cleanup error does not invent a failure for an otherwise passing cell.
          continuation = structuredClone(summary);
          runParams?.onEvidence?.(summary);
        },
        onScenarioStarted: (instanceId) => {
          if (!startedInstanceIds.has(instanceId)) {
            startedInstanceIds.add(instanceId);
            runParams?.onScenarioStarted?.(instanceId);
          }
        },
      }),
    QA_SUITE_INFRA_RETRY_LIMIT,
    runParams?.signal,
  );
  for (const id of result.startedScenarioInstanceIds ?? []) {
    startedInstanceIds.add(id);
  }
  const evidence = result.evidence;
  const startedRoots =
    evidence?.schemaVersion === 3
      ? resolveQaEvidenceContainment(evidence.occurrences, evidence.entries).rootInstances.filter(
          (anchor) => startedInstanceIds.has(anchor.id),
        )
      : [];
  const observedCells =
    evidence?.schemaVersion === 3
      ? // Direct flows have one planned lane; a transport fallback must not
        // replace its logical channel when projecting recorded dispatch.
        plan.expectedCells.filter((cell) =>
          startedRoots.some(
            ({ parentCell }) =>
              parentCell?.scenarioId === cell.scenarioId &&
              parentCell.executionKind === cell.executionKind,
          ),
        )
      : plan.scenarios
          .filter(
            (scenario) =>
              plan.scenarios.filter((candidate) => candidate.id === scenario.id).length === 1 &&
              result.startedScenarioIds.includes(scenario.id),
          )
          .flatMap((scenario) =>
            expandQaScenarioExecutionCells({
              scenarios: [scenario],
              channelDriver: runParams?.channelDriver ?? "qa-channel",
              channel: runParams?.channelId,
              expandChannels: false,
            }),
          );
  const observedKeys = new Set(observedCells.map((cell) => JSON.stringify(cell)));
  return {
    executionKind: "flow",
    expectedCells: plan.expectedCells,
    // Cell projections are canonical sets; repeated scheduled instances retain
    // their separate start/unknown state in occurrence evidence above.
    observedCells: [
      ...new Map(
        plan.expectedCells
          .filter((cell) => observedKeys.has(JSON.stringify(cell)))
          .map((cell) => [JSON.stringify(cell), cell]),
      ).values(),
    ],
    result,
  };
}

export async function runQaFlowSuiteFromRuntime(
  ...args: [QaSuiteRunParams?]
): Promise<QaSuiteResult> {
  return await (
    await loadQaFlowSuiteRuntime()
  )(args[0]);
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
