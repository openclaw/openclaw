import path from "node:path";
import { disposeRegisteredAgentHarnesses } from "openclaw/plugin-sdk/agent-harness";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaEvidenceSummaryV3Json } from "./evidence-summary.js";
import type { QaLabLatestReport } from "./lab-server.types.js";
import {
  formatQaScenarioFailureSuffix,
  sanitizeQaProgressValue as sanitizeQaSuiteProgressValue,
} from "./progress-format.js";
import { writeQaSuiteArtifacts } from "./suite-artifacts.js";
import { createQaSuiteEvidenceInvocation, rebaseQaSuiteEvidence } from "./suite-evidence.js";
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
  markQaSuiteNestedRun,
  requireQaSuiteStartLab,
  runQaSuiteCleanupSteps,
  throwQaSuiteCleanupErrors,
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
  const recording = await createQaSuiteEvidenceInvocation(params, context);
  const ownsLab = !params?.lab;
  const startLab = requireQaSuiteStartLab(params?.startLab);
  const lab =
    params?.lab ??
    (await startLab({
      repoRoot,
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    }));
  const transportFactoryResult = await createQaSuiteTransportAdapter({
    adapterFactories: params?.adapterFactories,
    channelDriver: params?.channelDriver,
    channelId: params?.channelId,
    channelDriverSelection: params?.channelDriverSelection,
    adapterOptions: {
      ...params?.adapterOptions,
      scenarioIds: selectedScenarios.map((scenario) => scenario.id),
    },
    cleanupOnFailure: ownsLab ? () => lab.stop() : undefined,
    outputDir,
    state: lab.state,
    transportId,
  });
  const transport = transportFactoryResult.adapter;
  const progress = createQaSuiteProgressController({
    lab,
    scenarios: selectedScenarios,
    startedAt: startedAt.toISOString(),
  });
  const completedScenarioResults: Array<QaSuiteScenarioResult | undefined> = Array.from({
    length: selectedScenarios.length,
  });
  const startedScenarioIndexes = new Set<number>();
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
          status: "running",
          repoRoot,
          outputDir,
          startedAt,
          finishedAt: partialFinishedAt,
          scenarios: partialScenarios,
          scenarioDefinitions: completedScenarioDefinitions,
          evidenceMode: params?.evidenceMode,
          recordedEvidence: recording.snapshot(),
          transport,
          providerMode,
          primaryModel,
          alternateModel,
          fastMode,
          concurrency,
          channel: params?.channelId ?? params?.channelDriverSelection?.channel ?? transport.id,
          channelDriver: transportFactoryResult.driver,
          isolatedWorkers: true,
          writeEvidenceFile: false,
          scenarioIds:
            params?.scenarioIds && params.scenarioIds.length > 0
              ? selectedScenarios.map((scenario) => scenario.id)
              : undefined,
        });
        lab.setLatestReport({
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
  try {
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
        progress.markRunning([index]);
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
              channelDriverSelection: params?.channelDriverSelection,
              primaryModel,
              alternateModel,
              fastMode,
              startLab,
              scenario,
              input: params,
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
          startedScenarioIndexes.add(index);
          const childSuiteResult: QaSuiteResult = await runQaFlowSuite(workerParams);
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
          progress.recordScenarioResult(index, scenarioResult);
          writeQaSuiteProgress(
            progressEnabled,
            `scenario ${scenarioResult.status} (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}${formatQaScenarioFailureSuffix(scenarioResult)}`,
          );
          completedScenarioResults[index] = scenarioResult;
          writePartialArtifacts();
          return scenarioResult;
        } catch (error) {
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
          progress.recordScenarioResult(index, scenarioResult);
          writeQaSuiteProgress(
            progressEnabled,
            `scenario fail (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}${formatQaScenarioFailureSuffix(scenarioResult)}`,
          );
          completedScenarioResults[index] = scenarioResult;
          writePartialArtifacts();
          return scenarioResult;
        }
      },
      {
        startStaggerMs: workerStartStaggerMs,
        shouldStop: (scenarioResult) =>
          params?.failFast === true && scenarioResult.status === "fail",
      },
    );
    terminalScenarios = scenarios;
    completionProgress = "run complete";
  } catch (error) {
    isolatedRunFailed = true;
    isolatedRunError = error;
    throw error;
  } finally {
    const cleanupSteps = [
      // Workers have settled, so this queue cannot grow during teardown.
      { phase: "partial artifacts", run: () => artifactWriteQueue },
      ...(!parentTransportCleaned
        ? [{ phase: "parent transport", run: () => transportFactoryResult.cleanupWithoutGateway() }]
        : []),
      { phase: "agent harnesses", run: () => disposeRegisteredAgentHarnesses() },
    ];
    if (ownsLab) {
      cleanupSteps.push({ phase: "lab stop", run: () => lab.stop() });
    }
    const cleanupFailures = await runQaSuiteCleanupSteps(cleanupSteps);
    throwQaSuiteCleanupErrors({
      cleanupFailures,
      runFailed: isolatedRunFailed,
      runError: isolatedRunError,
      scenarios: terminalScenarios,
    });
  }
  if (!terminalScenarios || !completionProgress) {
    throw new Error("QA suite completed without terminal result metadata");
  }
  const terminalFinishedAt = new Date();
  const { evidence, evidencePath, report, reportPath, summaryPath } = await writeQaSuiteArtifacts({
    repoRoot,
    outputDir,
    startedAt,
    finishedAt: terminalFinishedAt,
    scenarios: terminalScenarios,
    scenarioDefinitions: selectedScenarios,
    evidenceMode: params?.evidenceMode,
    recordedEvidence: recording.snapshot(),
    transport,
    providerMode,
    primaryModel,
    alternateModel,
    fastMode,
    concurrency,
    channel: params?.channelId ?? params?.channelDriverSelection?.channel ?? transport.id,
    channelDriver: transportFactoryResult.driver,
    channelDriverSelection: params?.channelDriverSelection,
    isolatedWorkers: true,
    writeEvidenceFile: params?.writeEvidenceFile,
    scenarioIds:
      params?.scenarioIds && params.scenarioIds.length > 0
        ? selectedScenarios.map((scenario) => scenario.id)
        : undefined,
  });
  lab.setLatestReport({
    outputPath: reportPath,
    markdown: report,
    generatedAt: terminalFinishedAt.toISOString(),
  } satisfies QaLabLatestReport);
  progress.complete([], terminalFinishedAt.toISOString());
  const result = {
    outputDir,
    evidence,
    evidencePath,
    reportPath,
    summaryPath,
    report,
    scenarios: terminalScenarios,
    startedScenarioIds: selectedScenarios
      .filter((_scenario, index) => startedScenarioIndexes.has(index))
      .map((scenario) => scenario.id),
    watchUrl: lab.baseUrl,
  } satisfies QaSuiteResult;
  writeQaSuiteProgress(progressEnabled, completionProgress);
  return result;
}
