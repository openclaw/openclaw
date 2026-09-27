import { randomUUID } from "node:crypto";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaRunnerTransportArtifacts } from "openclaw/plugin-sdk/qa-runner-runtime";
import { combineQaSuiteErrors, QaSuiteCleanupError } from "./errors.js";
import type { QaEvidenceSummaryV3Json } from "./evidence-summary.js";
import type { QaLabLatestReport, QaLabServerHandle } from "./lab-server.types.js";
import { sanitizeQaProgressValue as sanitizeQaSuiteProgressValue } from "./progress-format.js";
import {
  runRuntimeParityScenario,
  type RuntimeId,
  type RuntimeParityCell,
} from "./runtime-parity.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import {
  createQaSuiteEvidenceInvocation,
  describeQaSuiteInterruption,
  rebaseQaSuiteEvidence,
} from "./suite-evidence.js";
import {
  collectQaSuiteTransportPolicy,
  mapQaSuiteWithConcurrency,
  resolveQaSuiteWorkerStartStaggerMs,
  scenarioRequiresControlUi,
} from "./suite-planning.js";
import { createQaSuiteProgressController } from "./suite-progress.js";
import { buildRuntimeParityScenarioResult } from "./suite-runtime-parity-result.js";
import { remapModelRefForForcedRuntime } from "./suite-support.js";
import type {
  QaSuiteRunParams,
  QaSuiteRunner,
  QaSuiteScenarioResult,
  QaSuiteResult,
  QaSuiteResolvedRunContext,
} from "./suite-types.js";
import {
  createQaSuiteTransportAdapter,
  prepareQaSuiteAdapterFactories,
  markQaSuiteNestedRun,
  requireQaSuiteStartLab,
  runQaSuiteCleanupSteps,
  publishQaSuiteTerminalResult,
  writeQaSuiteProgress,
} from "./suite.js";

export async function runQaRuntimeParitySuite(
  params: Omit<QaSuiteRunParams, "channelDriver" | "scenarioIds"> &
    Pick<
      QaSuiteResolvedRunContext,
      | "repoRoot"
      | "outputDir"
      | "startedAt"
      | "providerMode"
      | "transportId"
      | "primaryModel"
      | "alternateModel"
      | "fastMode"
      | "concurrency"
      | "selectedScenarios"
      | "progressEnabled"
    > & {
      runQaFlowSuite: QaSuiteRunner;
      channelDriver?: QaSuiteRunParams["channelDriver"] | null;
      scenarioIds?: readonly string[];
      runtimePair: [RuntimeId, RuntimeId];
    },
) {
  const recording = await createQaSuiteEvidenceInvocation(
    {
      evidenceAnchors: params.evidenceAnchors,
      evidenceContinuation: params.evidenceContinuation,
      onEvidence: params.onEvidence,
      onScenarioStarted: params.onScenarioStarted,
      evidenceMode: params.evidenceMode,
      channelId: params.channelId,
      channelDriver: params.channelDriver ?? undefined,
    },
    params,
    (index, result) => {
      completedScenarioResults[index] = result;
      progress?.commitScenarioResult(index, result);
    },
  );
  const ownsLab = !params.lab;
  let lab: QaLabServerHandle | undefined = params.lab;
  let transportFactoryResult: Awaited<ReturnType<typeof createQaSuiteTransportAdapter>> | undefined;
  let progress = lab
    ? createQaSuiteProgressController({
        lab,
        scenarios: params.selectedScenarios,
        startedAt: params.startedAt.toISOString(),
      })
    : undefined;

  let runFailed = false;
  let runError: unknown;
  let parentTransportCleaned = false;
  let terminalScenarios: QaSuiteScenarioResult[] | undefined;
  let transportArtifacts: QaRunnerTransportArtifacts | undefined;
  let terminalResult: QaSuiteResult | undefined;
  const completedScenarioResults: Array<QaSuiteScenarioResult | undefined> = [];
  const childCleanupFailures: QaSuiteCleanupError[] = [];
  const publishTerminalResult = async () => {
    const scenarios = completedScenarioResults.filter(
      (result): result is QaSuiteScenarioResult => result !== undefined,
    );
    const finishedAt = new Date();
    const { evidence, evidencePath, report, reportPath, summaryPath } = await writeQaSuiteArtifacts(
      {
        repoRoot: params.repoRoot,
        outputDir: params.outputDir,
        startedAt: params.startedAt,
        finishedAt,
        scenarios,
        scenarioDefinitions: params.selectedScenarios,
        evidenceMode: params.evidenceMode,
        recordedEvidence: recording.snapshot(),
        transport: transportFactoryResult?.adapter,
        providerMode: params.providerMode,
        primaryModel: params.primaryModel,
        alternateModel: params.alternateModel,
        fastMode: params.fastMode,
        concurrency: params.concurrency,
        channel: params.channelId ?? params.transportId,
        channelDriver: transportFactoryResult?.driver ?? params.channelDriver,
        transportArtifacts,
        scenarioIds:
          params.scenarioIds && params.scenarioIds.length > 0
            ? params.selectedScenarios.map((scenario) => scenario.id)
            : undefined,
        runtimePair: params.runtimePair,
        writeEvidenceFile: params.writeEvidenceFile,
        onArtifactsPublished: params.onArtifactsPublished,
      },
    );
    lab?.setLatestReport({
      outputPath: reportPath,
      markdown: report,
      generatedAt: finishedAt.toISOString(),
    } satisfies QaLabLatestReport);
    progress?.complete([], finishedAt.toISOString());
    return {
      outputDir: params.outputDir,
      evidence,
      evidencePath,
      reportPath,
      summaryPath,
      report,
      scenarios,
      ...recording.startedScenarios(),
      watchUrl: lab?.baseUrl ?? "",
    } satisfies QaSuiteResult;
  };
  try {
    const adapterFactories = await prepareQaSuiteAdapterFactories(
      { ...params, channelDriver: params.channelDriver ?? undefined },
      params,
    );
    const startLab = requireQaSuiteStartLab(params.startLab);
    lab ??= await startLab({
      repoRoot: params.repoRoot,
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    });
    progress ??= createQaSuiteProgressController({
      lab,
      scenarios: params.selectedScenarios,
      startedAt: params.startedAt.toISOString(),
    });
    params.signal?.throwIfAborted();
    transportFactoryResult = await createQaSuiteTransportAdapter({
      adapterFactories,
      channelDriver: params.channelDriver,
      channelId: params.channelId,
      adapterOptions: params.adapterOptions,
      outputDir: params.outputDir,
      transportPolicy: collectQaSuiteTransportPolicy(params.selectedScenarios),
      state: lab.state,
      transportId: params.transportId,
    });
    const transport = transportFactoryResult.adapter;
    params.signal?.throwIfAborted();
    progress.start();
    if (params.channelDriver === "live") {
      // The parent only contributes aggregate metadata; release its exclusive
      // live credential before runtime cells acquire the same transport lease.
      await transportFactoryResult.cleanupWithoutGateway();
      parentTransportCleaned = true;
    }
    const scenarios = await mapQaSuiteWithConcurrency(
      params.selectedScenarios,
      params.concurrency,
      async (scenario, index): Promise<QaSuiteScenarioResult> => {
        const scenarioIdForLog = sanitizeQaSuiteProgressValue(scenario.id);
        writeQaSuiteProgress(
          params.progressEnabled,
          `runtime pair start (${index + 1}/${params.selectedScenarios.length}): ${scenarioIdForLog}`,
        );
        progress!.markRunning([index]);
        const anchor = recording.invocation.anchors[index]!;
        const comparisonId = recording.invocation.begin(index, undefined, { diagnostic: true });
        recording.publish();
        const comparisonDir = path.join(params.outputDir, "runtime-cells", anchor.id, comparisonId);
        // Each comparison owns two independent runtime instances. Its retry
        // retires this whole bundle without rewriting captured child history.
        const cells = await createQaSuiteEvidenceInvocation(
          {
            evidenceAnchors: params.runtimePair.map(() => ({
              ...anchor,
              id: randomUUID(),
              scenario: { kind: "instance", resultOccurrenceId: null },
            })),
            evidenceMode: params.evidenceMode,
            channelId: params.channelId,
            channelDriver: params.channelDriver ?? undefined,
          },
          {
            ...params,
            outputDir: comparisonDir,
            selectedScenarios: params.runtimePair.map(() => scenario),
          },
        );
        const capturedCells = () =>
          rebaseQaSuiteEvidence(cells.snapshot(), comparisonDir, params.outputDir);
        let recordingComparison = false;
        try {
          const parity = await runRuntimeParityScenario({
            scenarioId: scenario.id,
            runtimeParityUsage: scenario.runtimeParityUsage,
            runtimePair: params.runtimePair,
            runCell: async (runtime) => {
              const cleanupFailure = childCleanupFailures[0];
              if (cleanupFailure) {
                throw cleanupFailure;
              }
              params.signal?.throwIfAborted();
              const cellIndex = params.runtimePair.indexOf(runtime);
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
                if (selected === null) {
                  cells.invocation.select(cellIndex, null);
                } else {
                  cells.invocation.select(cellIndex, selected);
                }
                return selected;
              };
              let cellResult: QaSuiteResult;
              try {
                cellResult = await params.runQaFlowSuite(
                  markQaSuiteNestedRun<QaSuiteRunParams>({
                    signal: params.signal,
                    forwardParentSignals: params.forwardParentSignals,
                    adapterFactories,
                    channelId: params.channelId,
                    adapterOptions: params.adapterOptions,
                    repoRoot: params.repoRoot,
                    outputDir: cellOutputDir,
                    providerMode: params.providerMode,
                    transportId: params.transportId,
                    channelDriver: params.channelDriver ?? undefined,
                    primaryModel: remapModelRefForForcedRuntime({
                      modelRef: params.primaryModel,
                      providerMode: params.providerMode,
                      forcedRuntime: runtime,
                    }),
                    alternateModel: remapModelRefForForcedRuntime({
                      modelRef: params.alternateModel,
                      providerMode: params.providerMode,
                      forcedRuntime: runtime,
                    }),
                    fastMode: params.fastMode,
                    thinkingDefault: params.thinkingDefault,
                    claudeCliAuthMode: params.claudeCliAuthMode,
                    scenarioIds: [scenario.id],
                    ...(params.scenarioDefinitions ? { scenarioDefinitions: [scenario] } : {}),
                    concurrency: 1,
                    enabledPluginIds: params.enabledPluginIds,
                    startLab,
                    controlUiEnabled:
                      params.controlUiEnabled ?? scenarioRequiresControlUi(scenario),
                    mutateConfig: params.mutateConfig,
                    sutOpenClawCommand: params.sutOpenClawCommand,
                    forcedRuntime: runtime,
                    captureRuntimeParityCell: true,
                    writeEvidenceFile: params.writeEvidenceFile,
                    evidenceAnchors: [cells.invocation.anchors[cellIndex]!],
                    onEvidence: (summary) => {
                      childEvidence = structuredClone(summary);
                      importChild();
                    },
                    onScenarioStarted: () => recording.markStarted(index),
                  }),
                );
              } catch (error) {
                // Close admission at child settlement, before diagnostic writes
                // can yield another worker or the next runtime cell a slot.
                if (error instanceof QaSuiteCleanupError) {
                  childCleanupFailures.push(error);
                }
                try {
                  importChild();
                } catch (reconciliationError) {
                  throw combineQaSuiteErrors(
                    [error, reconciliationError],
                    "runtime parity child and evidence reconciliation failed",
                    { cause: reconciliationError },
                  );
                }
                throw error;
              }
              if (cellResult.evidence?.schemaVersion === 3) {
                childEvidence = cellResult.evidence;
              }
              const childSelectedId = importChild();
              if (cellResult.startedScenarioIds.includes(scenario.id)) {
                recording.markStarted(index);
              }
              let scenarioResult =
                cellResult.scenarios[0] ??
                ({
                  name: scenario.title,
                  status: "fail",
                  details: "runtime parity cell returned no scenario result",
                  steps: [
                    {
                      name: "runtime parity cell",
                      status: "fail",
                      details: "runtime parity cell returned no scenario result",
                    },
                  ],
                } satisfies QaSuiteScenarioResult);
              if (childEvidence) {
                if (!childSelectedId || scenarioResult.evidenceOccurrenceId !== childSelectedId) {
                  throw new Error("runtime parity result does not match its child observation");
                }
                cells.invocation.complete(dispatchId, {
                  status: scenarioResult.status === "skip" ? "skipped" : scenarioResult.status,
                  entries: [],
                });
              } else {
                // Only this just-returned child can supply legacy rows. Keep their
                // complete contents; runtime labels do not establish target proof.
                const legacy = cellResult.evidence
                  ? rebaseQaSuiteEvidence(cellResult.evidence, cellOutputDir, comparisonDir)
                  : undefined;
                scenarioResult = await cells.record(cellIndex, dispatchId, scenarioResult, {
                  importedEntries: legacy?.entries,
                });
              }
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

          const parityResult = buildRuntimeParityScenarioResult({
            scenarioName: scenario.title,
            result: parity,
          });
          recordingComparison = true;
          const parityScenarioResult = await recording.record(index, comparisonId, parityResult, {
            diagnostic: true,
            childEvidence: capturedCells(),
          });
          progress!.recordScenarioResult(index, parityScenarioResult);
          writeQaSuiteProgress(
            params.progressEnabled,
            `runtime pair ${parityScenarioResult.status} (${index + 1}/${params.selectedScenarios.length}): ${scenarioIdForLog}`,
          );
          return parityScenarioResult;
        } catch (error) {
          // A comparison failure owns a separate zero-claim diagnostic; already
          // captured child observations survive without inventing a child result.
          if (!recordingComparison) {
            const details = formatErrorMessage(error);
            try {
              const scenarioResult = await recording.record(
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
              progress!.recordScenarioResult(index, scenarioResult);
            } catch (recordError) {
              throw combineQaSuiteErrors(
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
        signal: params.signal,
        canStart: () => childCleanupFailures.length === 0,
        startStaggerMs: resolveQaSuiteWorkerStartStaggerMs(params.concurrency),
      },
    );

    terminalScenarios = scenarios;
    transportArtifacts = await transport.captureArtifacts?.({ outputDir: params.outputDir });
  } catch (error) {
    runFailed = true;
    runError = error;
    throw error;
  } finally {
    if (!terminalScenarios && completedScenarioResults.some((result) => result !== undefined)) {
      terminalScenarios = completedScenarioResults.filter(
        (result): result is QaSuiteScenarioResult => result !== undefined,
      );
    }
    const cleanupFailures = await runQaSuiteCleanupSteps([
      ...(transportFactoryResult && !parentTransportCleaned
        ? [{ phase: "parent transport", run: transportFactoryResult.cleanupWithoutGateway }]
        : []),
      ...(ownsLab && lab ? [{ phase: "lab stop", run: lab.stop }] : []),
    ]);
    const interruption =
      runFailed && !transportFactoryResult && runError !== params.signal?.reason
        ? `suite preparation failed: ${formatErrorMessage(runError)}`
        : describeQaSuiteInterruption(params.signal, childCleanupFailures[0] ?? runError);
    terminalResult = await publishQaSuiteTerminalResult({
      cleanupFailures: [
        ...childCleanupFailures
          .filter((error) => error !== runError)
          .map((error) => ({ phase: "runtime cell", error })),
        ...cleanupFailures,
      ],
      runFailed,
      runError,
      scenarios: terminalScenarios,
      finalize: () => recording.finalizeInterrupted(interruption),
      publish: terminalScenarios || interruption ? publishTerminalResult : undefined,
    });
  }
  if (!terminalResult) {
    throw new Error("QA runtime parity suite completed without a result");
  }
  writeQaSuiteProgress(params.progressEnabled, "run complete");
  return terminalResult;
}
