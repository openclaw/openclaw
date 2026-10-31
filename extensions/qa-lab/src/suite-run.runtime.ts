import { randomUUID } from "node:crypto";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaRunnerTransportArtifacts } from "openclaw/plugin-sdk/qa-runner-runtime";
import type { QaEvidenceSummaryV3Json } from "./evidence-summary.js";
import { remapModelRefForForcedRuntime } from "./model-selection.js";
import { sanitizeQaProgressValue as sanitizeQaSuiteProgressValue } from "./progress-format.js";
import { QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY } from "./qa-channel-transport.js";
import {
  normalizeQaTransportId,
  prepareQaTransportAdapterFactories,
  qaTransportSupportsModuleFlows,
} from "./qa-transport-registry.js";
import {
  isRuntimeParityResultPass,
  runRuntimeParityScenario,
  runtimeParityCellStatus,
  type RuntimeParityCell,
  type RuntimeParityResult,
} from "./runtime-parity.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { expandQaScenarioExecutionCells } from "./scenario-lane.js";
import { invalidateQaSuiteArtifactGeneration } from "./suite-artifacts.js";
import { createQaSuiteEvidenceInvocation, rebaseQaSuiteEvidence } from "./suite-evidence.js";
import { resolveRequestedQaSuiteModels } from "./suite-model-selection.js";
import {
  collectQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuitePluginIds,
  normalizeQaSuiteConcurrency,
  resolveQaSuiteOutputDir,
  selectQaFlowSuiteScenarios,
  mapQaSuiteWithConcurrency,
  resolveQaSuiteWorkerStartStaggerMs,
  scenarioRequiresControlUi,
} from "./suite-planning.js";
import { createQaSuiteProgressController } from "./suite-progress.js";
import { completeQaSuiteRun } from "./suite-run-completion.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import { createQaSuiteRunResources } from "./suite-run-resources.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { shouldCaptureGatewayHeapCheckpoints } from "./suite-support.js";
import type {
  QaSuiteRunParams,
  QaSuiteScenarioResult,
  QaSuiteResult,
  QaSuiteResolvedRunContext,
} from "./suite-types.js";
import {
  markQaSuiteNestedRun,
  requireQaSuiteStartLab,
  runQaSuiteCleanupSteps,
  throwQaSuiteCleanupErrors,
  writeQaSuiteProgress,
  formatQaSuiteRunStartProgress,
  isQaSuiteNestedRun,
  runQaSuiteScenarioDefinitionForRuntime,
  shouldLogQaSuiteProgress,
  shouldRunQaSuiteWithIsolatedScenarioWorkers,
} from "./suite.js";
export async function runQaFlowSuiteFromRuntime(params?: QaSuiteRunParams): Promise<QaSuiteResult> {
  const startedAt = new Date();
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const scenarios = params?.scenarioDefinitions ?? readQaBootstrapScenarioCatalog().scenarios;
  const requestedModels = resolveRequestedQaSuiteModels({
    ...params,
    scenarios,
  });
  const transportId = normalizeQaTransportId(params?.transportId);
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, params?.outputDir);
  const channelDriver = params?.channelDriver;
  const selectedScenarios = selectQaFlowSuiteScenarios({
    scenarios,
    scenarioIds: params?.scenarioIds,
    providerMode: requestedModels.providerMode,
    primaryModel: requestedModels.primaryModel,
    channelDriver,
    channel: params?.channelId,
    claudeCliAuthMode: params?.claudeCliAuthMode,
    resolveModuleFlowSupport: (channel) =>
      qaTransportSupportsModuleFlows(params?.adapterFactories, {
        channelId: channel ?? params?.channelId ?? transportId,
        driver: channelDriver ?? transportId,
      }),
  });
  if (selectedScenarios.length === 0) {
    throw new Error(
      "QA suite selected no runnable scenarios; check the scenario catalog and provider, model, or channel filters.",
    );
  }
  const { alternateModel, fastMode, primaryModel, providerMode } = requestedModels;
  if (
    params?.roundTripProbe &&
    !selectedScenarios.some((scenario) => scenario.id === params.roundTripProbe?.scenarioId)
  ) {
    throw new Error(
      `QA round-trip check scenario is not selected: ${params.roundTripProbe.scenarioId}`,
    );
  }
  if (params?.roundTripProbe && params.runtimePair) {
    throw new Error("QA round-trip checks are not supported with runtime-pair runs.");
  }
  await invalidateQaSuiteArtifactGeneration(outputDir);
  const preparedParams = {
    ...params,
    adapterFactories: await prepareQaTransportAdapterFactories({
      factories: params?.adapterFactories,
      driver: channelDriver,
      cells: expandQaScenarioExecutionCells({
        scenarios: selectedScenarios,
        channelDriver: channelDriver ?? transportId,
        channel: params?.channelId,
        expandChannels: false,
      }),
    }),
  };
  // Preparation copies params, so carry the child's publication ownership to the new object.
  if (isQaSuiteNestedRun(params)) {
    markQaSuiteNestedRun(preparedParams);
  }
  const enabledPluginIds = [
    ...new Set([
      ...collectQaSuitePluginIds(selectedScenarios),
      ...(params?.enabledPluginIds ?? []).map((pluginId) => pluginId.trim()).filter(Boolean),
      ...(params?.forcedRuntime && params.forcedRuntime !== "openclaw"
        ? [params.forcedRuntime]
        : []),
    ]),
  ];
  const gatewayConfigPatches = collectQaSuiteGatewayConfigPatches(
    selectedScenarios,
    params?.adapterOptions?.sutAccountId?.trim() ||
      (channelDriver === "crabline" ? "default" : "sut"),
  );
  const gatewayRuntimeOptions = collectQaSuiteGatewayRuntimeOptions(selectedScenarios);
  const concurrency = params?.failFast
    ? 1
    : normalizeQaSuiteConcurrency(
        params?.concurrency,
        selectedScenarios.length,
        channelDriver === "crabline" ? 1 : QA_CHANNEL_DEFAULT_SUITE_CONCURRENCY,
      );
  const progressEnabled = shouldLogQaSuiteProgress();
  const context: QaSuiteResolvedRunContext = {
    startedAt,
    repoRoot,
    outputDir,
    transportId,
    selectedScenarios,
    providerMode,
    primaryModel,
    alternateModel,
    fastMode,
    channelDriver,
    enabledPluginIds,
    gatewayConfigPatches,
    gatewayRuntimeOptions,
    concurrency,
    progressEnabled,
    gatewayHeapCheckpointsEnabled: shouldCaptureGatewayHeapCheckpoints(),
  };
  writeQaSuiteProgress(
    progressEnabled,
    formatQaSuiteRunStartProgress({
      selectedScenarioCount: selectedScenarios.length,
      concurrency,
      transportId,
      channelDriver: params?.channelDriver,
      channelId: params?.channelId,
    }),
  );
  const useIsolatedScenarioWorkers = shouldRunQaSuiteWithIsolatedScenarioWorkers({
    scenarios: selectedScenarios,
    concurrency,
    lab: params?.lab,
    startLab: params?.startLab,
  });
  if (params?.runtimePair) {
    const parityParams = {
      ...preparedParams,
      ...context,
      // Each parity child adds its scenario plugins during its own preparation.
      enabledPluginIds: params.enabledPluginIds,
      runtimePair: params.runtimePair,
    };
    const recording = await createQaSuiteEvidenceInvocation(
      {
        evidenceAnchors: parityParams.evidenceAnchors,
        evidenceContinuation: parityParams.evidenceContinuation,
        onEvidence: parityParams.onEvidence,
        evidenceMode: parityParams.evidenceMode,
        channelId: parityParams.channelId,
        channelDriver: parityParams.channelDriver ?? undefined,
      },
      parityParams,
    );
    const startLab = requireQaSuiteStartLab(parityParams.startLab);
    const { lab, ownsLab, transportFactoryResult, transport, artifactParams } =
      await createQaSuiteRunResources(parityParams, parityParams, "runtime-pair");
    const progress = createQaSuiteProgressController({
      lab,
      scenarios: parityParams.selectedScenarios,
      startedAt: parityParams.startedAt.toISOString(),
    });
    progress.start();

    let runFailed = false;
    let runError: unknown;
    let parentTransportCleaned = false;
    let terminalScenarios: QaSuiteScenarioResult[] | undefined;
    let transportArtifacts: QaRunnerTransportArtifacts | undefined;
    const startedScenarioIndexes = new Set<number>();
    try {
      if (parityParams.channelDriver === "live") {
        // The parent only contributes aggregate metadata; release its exclusive
        // live credential before runtime cells acquire the same transport lease.
        await transportFactoryResult.cleanupWithoutGateway();
        parentTransportCleaned = true;
      }
      const parityScenarios = await mapQaSuiteWithConcurrency(
        parityParams.selectedScenarios,
        parityParams.concurrency,
        async (scenario, index): Promise<QaSuiteScenarioResult> => {
          const scenarioIdForLog = sanitizeQaSuiteProgressValue(scenario.id);
          writeQaSuiteProgress(
            parityParams.progressEnabled,
            `runtime pair start (${index + 1}/${parityParams.selectedScenarios.length}): ${scenarioIdForLog}`,
          );
          progress.markRunning([index]);
          const anchor = recording.invocation.anchors[index]!;
          const comparisonId = recording.invocation.begin(index, undefined, { diagnostic: true });
          recording.publish();
          const comparisonDir = path.join(
            parityParams.outputDir,
            "runtime-cells",
            anchor.id,
            comparisonId,
          );
          // Each comparison owns two independent runtime instances. Its retry
          // retires this whole bundle without rewriting captured child history.
          const cells = await createQaSuiteEvidenceInvocation(
            {
              evidenceAnchors: parityParams.runtimePair.map(() => ({
                ...anchor,
                id: randomUUID(),
                scenario: { kind: "instance", resultOccurrenceId: null },
              })),
              evidenceMode: parityParams.evidenceMode,
              channelId: parityParams.channelId,
              channelDriver: parityParams.channelDriver ?? undefined,
            },
            {
              ...parityParams,
              outputDir: comparisonDir,
              selectedScenarios: parityParams.runtimePair.map(() => scenario),
            },
          );
          const capturedCells = () =>
            rebaseQaSuiteEvidence(cells.snapshot(), comparisonDir, parityParams.outputDir);
          let recordingComparison = false;
          try {
            const parity = await runRuntimeParityScenario({
              scenarioId: scenario.id,
              runtimeParityUsage: scenario.runtimeParityUsage,
              runtimePair: parityParams.runtimePair,
              runCell: async (runtime) => {
                const cellIndex = parityParams.runtimePair.indexOf(runtime);
                const cellOutputDir = path.join(comparisonDir, runtime);
                const dispatchId = cells.invocation.begin(cellIndex, null, { diagnostic: true });
                const cellStartedAt = Date.now();
                let childEvidence: QaEvidenceSummaryV3Json | undefined;
                const importChild = () => {
                  if (!childEvidence) {
                    return null;
                  }
                  const selected = cells.invocation.importChild(
                    cellIndex,
                    rebaseQaSuiteEvidence(childEvidence, cellOutputDir, comparisonDir),
                  );
                  // A callback can capture an unfinished child with no selection.
                  // Admit that pending history too before an exception unwinds it.
                  cells.invocation.select(cellIndex, selected);
                  return selected;
                };
                let cellResult: QaSuiteResult;
                try {
                  cellResult = await runQaFlowSuiteFromRuntime(
                    markQaSuiteNestedRun<QaSuiteRunParams>({
                      adapterFactories: parityParams.adapterFactories,
                      channelId: parityParams.channelId,
                      adapterOptions: parityParams.adapterOptions,
                      repoRoot: parityParams.repoRoot,
                      outputDir: cellOutputDir,
                      providerMode: parityParams.providerMode,
                      transportId: parityParams.transportId,
                      channelDriver: parityParams.channelDriver ?? undefined,
                      primaryModel: remapModelRefForForcedRuntime({
                        modelRef: parityParams.primaryModel,
                        providerMode: parityParams.providerMode,
                        forcedRuntime: runtime,
                      }),
                      alternateModel: remapModelRefForForcedRuntime({
                        modelRef: parityParams.alternateModel,
                        providerMode: parityParams.providerMode,
                        forcedRuntime: runtime,
                      }),
                      fastMode: parityParams.fastMode,
                      thinkingDefault: parityParams.thinkingDefault,
                      claudeCliAuthMode: parityParams.claudeCliAuthMode,
                      scenarioIds: [scenario.id],
                      concurrency: 1,
                      enabledPluginIds: parityParams.enabledPluginIds,
                      startLab,
                      controlUiEnabled:
                        parityParams.controlUiEnabled ?? scenarioRequiresControlUi(scenario),
                      mutateConfig: parityParams.mutateConfig,
                      sutOpenClawCommand: parityParams.sutOpenClawCommand,
                      forcedRuntime: runtime,
                      captureRuntimeParityCell: true,
                      writeEvidenceFile: parityParams.writeEvidenceFile,
                      evidenceAnchors: [cells.invocation.anchors[cellIndex]!],
                      onEvidence: (summary) => {
                        childEvidence = summary;
                        importChild();
                      },
                    }),
                  );
                } catch (error) {
                  try {
                    importChild();
                  } catch (reconciliationError) {
                    throw new AggregateError(
                      [error, reconciliationError],
                      "runtime parity child and evidence reconciliation failed",
                      { cause: reconciliationError },
                    );
                  }
                  throw error;
                }
                childEvidence = cellResult.evidence;
                const childSelectedId = importChild();
                if (cellResult.startedScenarioIds.includes(scenario.id)) {
                  startedScenarioIndexes.add(index);
                }
                const scenarioResult = cellResult.scenarios[0];
                if (!scenarioResult) {
                  throw new Error("runtime parity cell returned no scenario result");
                }
                if (!childSelectedId || scenarioResult.evidenceOccurrenceId !== childSelectedId) {
                  throw new Error("runtime parity result does not match its child observation");
                }
                cells.invocation.complete(dispatchId, {
                  status: scenarioResult.status === "skip" ? "skipped" : scenarioResult.status,
                  entries: [],
                });
                const fallbackCell = {
                  runtime,
                  transcriptBytes: "",
                  toolCalls: [],
                  finalText: "",
                  usage: {
                    inputTokens: 0,
                    outputTokens: 0,
                    totalTokens: 0,
                  },
                  wallClockMs: Math.max(1, Date.now() - cellStartedAt),
                  runtimeErrorClass: "capture-missing",
                  bootStateLines: [],
                } satisfies RuntimeParityCell;
                return {
                  status: scenarioResult.status,
                  details: scenarioResult.details,
                  cell: cellResult.runtimeParityCell ?? fallbackCell,
                };
              },
            });

            const driftStepStatus = runtimeParityScenarioResultStatus(parity);
            const parityResult: QaSuiteScenarioResult = {
              name: scenario.title,
              status: driftStepStatus,
              details: parity.driftDetails ?? `runtime drift classified as ${parity.drift}`,
              steps: [
                ...[parity.cells.openclaw, parity.cells.codex].map((cell) => ({
                  name: cell.runtime,
                  status: runtimeParityCellStatus(cell),
                  details: [cell.details, formatRuntimeParityCellDetails(cell)]
                    .filter(Boolean)
                    .join("\n"),
                })),
                {
                  name: "runtime drift",
                  status: driftStepStatus,
                  details: parity.driftDetails ?? parity.drift,
                },
              ],
              runtimeParity: parity,
            };
            recordingComparison = true;
            const parityScenarioResult = await recording.record(index, comparisonId, parityResult, {
              diagnostic: true,
              childEvidence: capturedCells(),
            });
            progress.recordScenarioResult(index, parityScenarioResult);
            writeQaSuiteProgress(
              parityParams.progressEnabled,
              `runtime pair ${parityScenarioResult.status} (${index + 1}/${parityParams.selectedScenarios.length}): ${scenarioIdForLog}`,
            );
            return parityScenarioResult;
          } catch (error) {
            // A comparison failure owns a separate zero-claim diagnostic; already
            // captured child observations survive without inventing a child result.
            if (!recordingComparison) {
              const details = formatErrorMessage(error);
              try {
                await recording.record(
                  index,
                  comparisonId,
                  {
                    name: scenario.title,
                    status: "fail",
                    details,
                    steps: [{ name: "runtime parity", status: "fail", details }],
                  },
                  { diagnostic: true, childEvidence: capturedCells() },
                );
              } catch (recordError) {
                throw new AggregateError(
                  [error, recordError],
                  "runtime parity and evidence publication failed",
                  { cause: recordError },
                );
              }
            }
            throw error;
          }
        },
        {
          startStaggerMs: resolveQaSuiteWorkerStartStaggerMs(parityParams.concurrency),
        },
      );

      transportArtifacts = await transport.captureArtifacts?.({
        outputDir: parityParams.outputDir,
      });
      terminalScenarios = parityScenarios;
    } catch (error) {
      runFailed = true;
      runError = error;
      throw error;
    } finally {
      const cleanupFailures = await runQaSuiteCleanupSteps([
        ...(!parentTransportCleaned
          ? [
              {
                phase: "parent transport",
                run: () => transportFactoryResult.cleanupWithoutGateway(),
              },
            ]
          : []),
        ...(ownsLab ? [{ phase: "lab stop", run: () => lab.stop() }] : []),
      ]);
      throwQaSuiteCleanupErrors({
        cleanupFailures,
        runFailed,
        runError,
        scenarios: terminalScenarios,
      });
    }
    const finishedAt = new Date();
    const result = await completeQaSuiteRun(
      {
        ...artifactParams,
        finishedAt,
        scenarios: terminalScenarios,
        recordedEvidence: recording.snapshot(),
        transportArtifacts,
        runtimePair: parityParams.runtimePair,
        writeEvidenceFile: parityParams.writeEvidenceFile,
      },
      lab,
      progress,
      parityParams.selectedScenarios
        .filter((_scenario, index) => startedScenarioIndexes.has(index))
        .map((scenario) => scenario.id),
    );
    writeQaSuiteProgress(parityParams.progressEnabled, "run complete");
    return result;
  }
  return useIsolatedScenarioWorkers
    ? await runQaFlowSuiteIsolated(preparedParams, context, runQaFlowSuiteFromRuntime)
    : await runQaFlowSuiteStandard(preparedParams, context, runQaSuiteScenarioDefinitionForRuntime);
}

// QA Lab projects canonical runtime-pair results into suite scenario results.
function formatRuntimeParityCellDetails(cell: RuntimeParityCell) {
  const errors = [cell.transportErrorClass, cell.runtimeErrorClass].filter(Boolean).join(", ");
  const sentinels = cell.sentinelFindings?.map((finding) => finding.kind).join(", ");
  return [
    `runtime=${cell.runtime}`,
    `wallMs=${cell.wallClockMs}`,
    ...(cell.bootstrapWallClockMs === undefined
      ? []
      : [`bootstrapMs=${cell.bootstrapWallClockMs}`]),
    `toolCalls=${cell.toolCalls.length}`,
    `finalChars=${cell.finalText.length}`,
    `tokens=${cell.usage.totalTokens}`,
    ...(errors ? [`errors=${errors}`] : []),
    ...(sentinels ? [`sentinels=${sentinels}`] : []),
  ].join(" ");
}

function runtimeParityScenarioResultStatus(result: RuntimeParityResult) {
  if (isRuntimeParityResultPass(result)) {
    return "pass";
  }
  const statuses = new Set(
    [result.cells.openclaw, result.cells.codex].map(runtimeParityCellStatus),
  );
  return !statuses.has("fail") && statuses.has("skip") ? "skip" : "fail";
}
