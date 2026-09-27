import path from "node:path";
import { disposeRegisteredAgentHarnesses } from "openclaw/plugin-sdk/agent-harness";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaRunnerTransportArtifacts } from "openclaw/plugin-sdk/qa-runner-runtime";
import { QaSuiteCleanupError } from "./errors.js";
import type { QaEvidenceSummaryV3Json } from "./evidence-summary.js";
import type { QaLabLatestReport, QaLabServerHandle } from "./lab-server.types.js";
import {
  formatQaScenarioFailureSuffix,
  sanitizeQaProgressValue as sanitizeQaSuiteProgressValue,
} from "./progress-format.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import {
  createQaSuiteEvidenceInvocation,
  describeQaSuiteInterruption,
  rebaseQaSuiteEvidence,
} from "./suite-evidence.js";
import { mapQaSuiteWithConcurrency, resolveQaSuiteWorkerStartStaggerMs } from "./suite-planning.js";
import { createQaSuiteProgressController } from "./suite-progress.js";
import { buildQaIsolatedScenarioWorkerParams } from "./suite-support.js";
import type {
  QaSuiteResolvedRunContext,
  QaSuiteResult,
  QaSuiteRunner,
  QaSuiteRunParams,
  QaSuiteScenarioResult,
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

export async function runQaFlowSuiteIsolated(
  params: QaSuiteRunParams | undefined,
  context: QaSuiteResolvedRunContext,
  runQaFlowSuite: QaSuiteRunner,
): Promise<QaSuiteResult> {
  const {
    startedAt,
    repoRoot,
    outputDir,
    transportId,
    selectedScenarios,
    providerMode,
    primaryModel,
    alternateModel,
    fastMode,
    concurrency,
    progressEnabled,
  } = context;
  const recording = await createQaSuiteEvidenceInvocation(params, context, (index, result) => {
    completedScenarioResults[index] = result;
    progress?.commitScenarioResult(index, result);
  });
  const ownsLab = !params?.lab;
  let lab: QaLabServerHandle | undefined = params?.lab;
  let transportFactoryResult: Awaited<ReturnType<typeof createQaSuiteTransportAdapter>> | undefined;
  const artifactParams = () => ({
    repoRoot,
    outputDir,
    startedAt,
    evidenceMode: params?.evidenceMode,
    transport: transportFactoryResult?.adapter,
    providerMode,
    primaryModel,
    alternateModel,
    fastMode,
    concurrency,
    channel: params?.channelId ?? transportId,
    channelDriver: transportFactoryResult?.driver ?? params?.channelDriver,
    isolatedWorkers: true,
    scenarioIds: params?.scenarioIds?.length
      ? selectedScenarios.map((scenario) => scenario.id)
      : undefined,
  });
  let progress = lab
    ? createQaSuiteProgressController({
        lab,
        scenarios: selectedScenarios,
        startedAt: startedAt.toISOString(),
      })
    : undefined;
  const completedScenarioResults: Array<QaSuiteScenarioResult | undefined> = Array.from({
    length: selectedScenarios.length,
  });
  let artifactWriteQueue = Promise.resolve();
  const writePartialArtifacts = () => {
    const partialScenarios = completedScenarioResults.filter(
      (scenario): scenario is QaSuiteScenarioResult => scenario !== undefined,
    );
    const completedScenarioDefinitions = completedScenarioResults.flatMap((scenario, index) =>
      scenario === undefined || selectedScenarios[index] === undefined
        ? []
        : [selectedScenarios[index]],
    );
    if (partialScenarios.length === 0) {
      return;
    }
    artifactWriteQueue = artifactWriteQueue.then(async () => {
      // Only this write is best effort; prior queue rejection must reach cleanup.
      try {
        const partialFinishedAt = new Date();
        const { report, reportPath } = await writeQaSuiteArtifacts({
          ...artifactParams(),
          status: "running",
          finishedAt: partialFinishedAt,
          scenarios: partialScenarios,
          scenarioDefinitions: completedScenarioDefinitions,
          recordedEvidence: recording.snapshot(),
          writeEvidenceFile: false,
        });
        lab?.setLatestReport({
          outputPath: reportPath,
          markdown: report,
          generatedAt: partialFinishedAt.toISOString(),
        } satisfies QaLabLatestReport);
      } catch (error) {
        writeQaSuiteProgress(
          progressEnabled,
          `partial artifact write failed: ${sanitizeQaSuiteProgressValue(formatErrorMessage(error))}`,
        );
      }
    });
    // Observe callback rejection while workers drain; keep the rejected queue
    // for cleanup aggregation rather than turning it into a successful write.
    void artifactWriteQueue.catch(() => {});
  };

  let isolatedRunFailed = false;
  let isolatedRunError: unknown;
  let parentTransportCleaned = false;
  let completionProgress: string | undefined;
  let terminalScenarios: QaSuiteScenarioResult[] | undefined;
  let terminalResult: QaSuiteResult | undefined;
  const childCleanupFailures: Array<{ phase: string; error: unknown }> = [];
  let transportArtifacts: QaRunnerTransportArtifacts | undefined;
  const publishTerminalResult = async () => {
    terminalScenarios = completedScenarioResults.filter(
      (result): result is QaSuiteScenarioResult => result !== undefined,
    );
    const terminalFinishedAt = new Date();
    const { evidence, evidencePath, report, reportPath, summaryPath } = await writeQaSuiteArtifacts(
      {
        ...artifactParams(),
        finishedAt: terminalFinishedAt,
        scenarios: terminalScenarios,
        scenarioDefinitions: selectedScenarios,
        recordedEvidence: recording.snapshot(),
        transportArtifacts,
        writeEvidenceFile: params?.writeEvidenceFile,
        onArtifactsPublished: params?.onArtifactsPublished,
      },
    );
    lab?.setLatestReport({
      outputPath: reportPath,
      markdown: report,
      generatedAt: terminalFinishedAt.toISOString(),
    } satisfies QaLabLatestReport);
    progress?.complete([], terminalFinishedAt.toISOString());
    return {
      outputDir,
      evidence,
      evidencePath,
      reportPath,
      summaryPath,
      report,
      scenarios: terminalScenarios,
      ...recording.startedScenarios(),
      watchUrl: lab?.baseUrl ?? "",
    } satisfies QaSuiteResult;
  };
  try {
    const adapterFactories = await prepareQaSuiteAdapterFactories(params, context);
    const startLab = requireQaSuiteStartLab(params?.startLab);
    lab ??= await startLab({ repoRoot, host: "127.0.0.1", port: 0, embeddedGateway: "disabled" });
    progress ??= createQaSuiteProgressController({
      lab,
      scenarios: selectedScenarios,
      startedAt: startedAt.toISOString(),
    });
    params?.signal?.throwIfAborted();
    transportFactoryResult = await createQaSuiteTransportAdapter({
      adapterFactories,
      channelDriver: params?.channelDriver,
      channelId: params?.channelId,
      adapterOptions: {
        ...params?.adapterOptions,
        scenarioIds: selectedScenarios.map((scenario) => scenario.id),
      },
      outputDir,
      state: lab.state,
      transportId,
    });
    const transport = transportFactoryResult.adapter;
    params?.signal?.throwIfAborted();
    if (params?.channelDriver === "live") {
      // The parent only renders aggregate artifacts. Release its live credentials
      // before child workers acquire the same exclusive transport lease.
      await transportFactoryResult.cleanupWithoutGateway();
      parentTransportCleaned = true;
    }
    progress.start();
    const workerStartStaggerMs =
      params?.workerStartStaggerMs ?? resolveQaSuiteWorkerStartStaggerMs(concurrency);
    writeQaSuiteProgress(progressEnabled, `scenario start stagger=${workerStartStaggerMs}ms`);
    const scenarios: QaSuiteScenarioResult[] = await mapQaSuiteWithConcurrency(
      selectedScenarios,
      concurrency,
      async (scenario, index): Promise<QaSuiteScenarioResult> => {
        const scenarioIdForLog = sanitizeQaSuiteProgressValue(scenario.id);
        writeQaSuiteProgress(
          progressEnabled,
          `scenario start (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}`,
        );
        progress!.markRunning([index]);
        const anchor = recording.invocation.anchors[index]!;
        const scenarioOutputDir = path.join(outputDir, "scenarios", anchor.id);
        // Dispatch exists before child launch, including failures before its first result.
        const dispatchId = recording.invocation.begin(index, null, { diagnostic: true });
        let dispatchCompleted = false;
        let recordingStarted = false;
        let childEvidence: QaEvidenceSummaryV3Json | undefined;
        let imported = false;
        const importChild = () => {
          if (!childEvidence || imported) {
            return null;
          }
          const selected = recording.invocation.importChild(
            index,
            rebaseQaSuiteEvidence(childEvidence, scenarioOutputDir, outputDir),
          );
          imported = true;
          return selected;
        };
        try {
          const workerParams = markQaSuiteNestedRun(
            buildQaIsolatedScenarioWorkerParams({
              repoRoot,
              outputDir: scenarioOutputDir,
              providerMode,
              transportId,
              channelDriver: params?.channelDriver,
              channelId: params?.channelId,
              primaryModel,
              alternateModel,
              fastMode,
              startLab,
              scenario,
              input: { ...params, adapterFactories },
            }),
          );
          workerParams.evidenceAnchors = [anchor];
          const childInput = rebaseQaSuiteEvidence(
            recording.invocation.childInput(index),
            outputDir,
            scenarioOutputDir,
          );
          if (childInput.schemaVersion !== 3) {
            throw new Error("isolated child requires its captured invocation");
          }
          workerParams.evidenceContinuation = childInput;
          workerParams.onEvidence = (summary) => {
            childEvidence = structuredClone(summary);
          };
          workerParams.onScenarioStarted = () => recording.markStarted(index);
          const childSuiteResult: QaSuiteResult = await runQaFlowSuite(workerParams);
          if (childSuiteResult.startedScenarioIds.includes(scenario.id)) {
            recording.markStarted(index);
          }
          if (childSuiteResult.evidence?.schemaVersion === 3) {
            childEvidence = childSuiteResult.evidence;
          }
          const childSelectedId = importChild();
          let scenarioResult = childSuiteResult.scenarios[0];
          if (!scenarioResult) {
            throw new Error("isolated scenario run returned no scenario result");
          }
          if (childEvidence) {
            if (!childSelectedId || scenarioResult.evidenceOccurrenceId !== childSelectedId) {
              throw new Error("isolated result does not match its child's selected observation");
            }
            // The dispatch has no assertion claims. The child's actual result
            // stays selected; a later parent failure gets a separate observation.
            recordingStarted = true;
            await recording.record(index, dispatchId, scenarioResult, {
              importedEntries: [],
              selectedId: childSelectedId,
            });
          } else {
            // Only a result returned by this newly observed invocation is adapted.
            // Historical v2 files cannot acquire guessed occurrence provenance.
            const legacy = childSuiteResult.evidence
              ? rebaseQaSuiteEvidence(childSuiteResult.evidence, scenarioOutputDir, outputDir)
              : undefined;
            recordingStarted = true;
            scenarioResult = await recording.record(index, dispatchId, scenarioResult, {
              importedEntries: legacy?.entries,
            });
          }
          dispatchCompleted = true;
          progress!.recordScenarioResult(index, scenarioResult);
          writeQaSuiteProgress(
            progressEnabled,
            `scenario ${scenarioResult.status} (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}${formatQaScenarioFailureSuffix(scenarioResult)}`,
          );
          writePartialArtifacts();
          return scenarioResult;
        } catch (error) {
          if (error instanceof QaSuiteCleanupError) {
            childCleanupFailures.push({ phase: "isolated worker", error });
          }
          // A failed evidence write is not a child failure and must not retry
          // the same exclusive artifact name or mask its original error.
          if (recordingStarted && !dispatchCompleted) {
            throw error;
          }
          importChild();
          const details = formatErrorMessage(error);
          const failure = {
            name: scenario.title,
            status: "fail",
            details,
            steps: [
              {
                name: "isolated scenario worker",
                status: "fail",
                details,
              },
            ],
          } satisfies QaSuiteScenarioResult;
          const scenarioResult = await recording.record(
            index,
            dispatchCompleted
              ? recording.invocation.begin(index, null, { diagnostic: true })
              : dispatchId,
            failure,
            { diagnostic: true },
          );
          progress!.recordScenarioResult(index, scenarioResult);
          writeQaSuiteProgress(
            progressEnabled,
            `scenario fail (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}${formatQaScenarioFailureSuffix(scenarioResult)}`,
          );
          writePartialArtifacts();
          return scenarioResult;
        }
      },
      {
        signal: params?.signal,
        canStart: () => childCleanupFailures.length === 0,
        startStaggerMs: workerStartStaggerMs,
        shouldStop: (scenarioResult) =>
          params?.failFast === true && scenarioResult.status === "fail",
      },
    );
    terminalScenarios = scenarios;
    await artifactWriteQueue;
    transportArtifacts = await transport.captureArtifacts?.({ outputDir });
    completionProgress = "run complete";
  } catch (error) {
    isolatedRunFailed = true;
    isolatedRunError = error;
    throw error;
  } finally {
    if (!terminalScenarios && completedScenarioResults.some((result) => result !== undefined)) {
      terminalScenarios = completedScenarioResults.filter(
        (result): result is QaSuiteScenarioResult => result !== undefined,
      );
    }
    const cleanupSteps = [
      // Workers have settled, so this queue cannot grow during teardown.
      { phase: "partial artifacts", run: () => artifactWriteQueue },
      ...(transportFactoryResult && !parentTransportCleaned
        ? [{ phase: "parent transport", run: transportFactoryResult.cleanupWithoutGateway }]
        : []),
      { phase: "agent harnesses", run: () => disposeRegisteredAgentHarnesses() },
    ];
    if (ownsLab && lab) {
      cleanupSteps.push({ phase: "lab stop", run: lab.stop });
    }
    const cleanupFailures = await runQaSuiteCleanupSteps(cleanupSteps);
    const interruption =
      isolatedRunFailed && !transportFactoryResult && isolatedRunError !== params?.signal?.reason
        ? `suite preparation failed: ${formatErrorMessage(isolatedRunError)}`
        : describeQaSuiteInterruption(
            params?.signal,
            childCleanupFailures[0]?.error ?? isolatedRunError,
          );
    terminalResult = await publishQaSuiteTerminalResult({
      cleanupFailures: [...childCleanupFailures, ...cleanupFailures],
      runFailed: isolatedRunFailed,
      runError: isolatedRunError,
      scenarios: terminalScenarios,
      finalize: () => recording.finalizeInterrupted(interruption),
      publish: terminalScenarios || interruption ? publishTerminalResult : undefined,
    });
  }
  if (!terminalResult || !completionProgress) {
    throw new Error("QA suite completed without terminal result metadata");
  }
  writeQaSuiteProgress(progressEnabled, completionProgress);
  return terminalResult;
}
