import path from "node:path";
import { disposeRegisteredAgentHarnesses } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { createQaGatewayChild } from "./gateway-child.js";
import type { QaLabLatestReport } from "./lab-server.types.js";
import {
  formatQaScenarioFailureSuffix,
  sanitizeQaProgressValue as sanitizeQaSuiteProgressValue,
} from "./progress-format.js";
import { startQaProviderServer } from "./providers/server-runtime.js";
import {
  measureRuntimeParityCellTiming,
  type QaRuntimeParityCellTiming,
} from "./runtime-parity-timing.js";
import { captureRuntimeParityCell } from "./runtime-parity.js";
import {
  type QaSuiteGatewayHeapSnapshot,
  type QaSuiteGatewayRssSample,
  writeQaSuiteArtifacts,
} from "./suite-artifacts.js";
import { createQaSuiteEvidenceInvocation } from "./suite-evidence.js";
import {
  applyQaSuiteGatewayConfigPatches,
  collectQaSuiteTransportPolicy,
  scenarioRequiresControlUi,
} from "./suite-planning.js";
import { createQaSuiteProgressController } from "./suite-progress.js";
import { runQaSuiteRoundTripProbe } from "./suite-round-trip.js";
import { waitForGatewayHealthy, waitForTransportReady } from "./suite-runtime-gateway.js";
import {
  buildQaGatewayHeapCheckpointRuntimeEnvPatch,
  mergeQaRuntimeEnvPatches,
  runQaScenarioWithFlakeRetry,
} from "./suite-support.js";
import type {
  QaSuiteEnvironment,
  QaSuiteResolvedRunContext,
  QaSuiteResult,
  QaSuiteRunParams,
  QaSuiteScenarioRunner,
  QaSuiteScenarioResult,
} from "./suite-types.js";
import {
  createQaSuiteTransportAdapter,
  buildQaSuiteRuntimeMetrics,
  captureGatewayHeapSnapshotCheckpoint,
  isQaSuiteNestedRun,
  requireQaSuiteStartLab,
  resolveQaSuiteTransportReadyTimeoutMs,
  runQaFlowSuiteCleanupPlan,
  throwQaSuiteCleanupErrors,
  waitForQaLabReadyOrStopOwned,
  writeQaSuiteProgress,
} from "./suite.js";
import { closeQaWebSessions } from "./web-runtime.js";

export async function runQaFlowSuiteStandard(
  params: QaSuiteRunParams | undefined,
  context: QaSuiteResolvedRunContext,
  runScenarioDefinition: QaSuiteScenarioRunner,
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
    enabledPluginIds,
    gatewayConfigPatches,
    gatewayRuntimeOptions,
    concurrency,
    progressEnabled,
    gatewayHeapCheckpointsEnabled,
  } = context;
  const recording = await createQaSuiteEvidenceInvocation(params, context);
  const ownsLab = !params?.lab;
  const startLab = params?.startLab;
  const controlUiEnabled =
    params?.controlUiEnabled ?? selectedScenarios.some(scenarioRequiresControlUi);
  writeQaSuiteProgress(progressEnabled, "lab start");
  const lab =
    params?.lab ??
    (await requireQaSuiteStartLab(startLab)({
      repoRoot,
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    }));
  writeQaSuiteProgress(progressEnabled, `lab ready: ${sanitizeQaSuiteProgressValue(lab.baseUrl)}`);
  await waitForQaLabReadyOrStopOwned({ lab, ownsLab });
  const transportFactoryResult = await createQaSuiteTransportAdapter({
    adapterFactories: params?.adapterFactories,
    channelDriver: params?.channelDriver,
    channelId: params?.channelId,
    adapterOptions: {
      ...params?.adapterOptions,
      scenarioIds: selectedScenarios.map((scenario) => scenario.id),
    },
    cleanupOnFailure: ownsLab ? () => lab.stop() : undefined,
    outputDir,
    transportPolicy: collectQaSuiteTransportPolicy(selectedScenarios),
    state: lab.state,
    transportId,
  });
  const transport = transportFactoryResult.adapter;
  let mock: Awaited<ReturnType<typeof startQaProviderServer>> | undefined;
  const gateway = createQaGatewayChild();
  let env: QaSuiteEnvironment | undefined;
  let preserveGatewayRuntimeDir: string | undefined;
  let runFailed = false;
  let runError: unknown;
  let completionProgress: string | undefined;
  let terminalScenarios: QaSuiteScenarioResult[] | undefined;
  let publishTerminalResult: (() => Promise<QaSuiteResult>) | undefined;
  const startedScenarioIds: string[] = [];
  try {
    writeQaSuiteProgress(progressEnabled, `provider start: ${providerMode}`);
    const activeMock = await startQaProviderServer(providerMode, {
      modelRefs: [primaryModel, alternateModel],
    });
    mock = activeMock;
    writeQaSuiteProgress(
      progressEnabled,
      `provider ready: ${sanitizeQaSuiteProgressValue(activeMock?.baseUrl ?? "live")}`,
    );
    writeQaSuiteProgress(progressEnabled, "gateway start");
    const activeGateway = await gateway.start({
      repoRoot,
      command: params?.sutOpenClawCommand,
      providerBaseUrl: activeMock ? `${activeMock.baseUrl}/v1` : undefined,
      transport,
      transportBaseUrl: lab.listenUrl,
      controlUiAllowedOrigins: [lab.listenUrl],
      providerMode,
      primaryModel,
      alternateModel,
      fastMode,
      thinkingDefault: params?.thinkingDefault,
      forcedRuntime: params?.forcedRuntime,
      claudeCliAuthMode: params?.claudeCliAuthMode,
      controlUiEnabled,
      enabledPluginIds,
      allowUnhealthyStartup: gatewayRuntimeOptions?.allowUnhealthyStartup,
      forwardHostHome: gatewayRuntimeOptions?.forwardHostHome,
      mutateConfig:
        gatewayConfigPatches.length > 0 || params?.mutateConfig
          ? (cfg) => {
              const patchedConfig = gatewayConfigPatches.length
                ? (applyQaSuiteGatewayConfigPatches(cfg, gatewayConfigPatches) as OpenClawConfig)
                : cfg;
              return params?.mutateConfig ? params.mutateConfig(patchedConfig) : patchedConfig;
            }
          : undefined,
      // The gateway owns forced runtime, sandbox args, staged mock models, and provider keys.
      runtimeEnvPatch: mergeQaRuntimeEnvPatches(
        transport.createRuntimeEnvPatch?.(),
        buildQaGatewayHeapCheckpointRuntimeEnvPatch(),
      ),
    });
    writeQaSuiteProgress(
      progressEnabled,
      `gateway ready: ${sanitizeQaSuiteProgressValue(activeGateway.baseUrl)}`,
    );
    if (controlUiEnabled) {
      lab.setControlUi({
        controlUiProxyTarget: activeGateway.baseUrl,
        controlUiProxyToken: activeGateway.token,
      });
    }
    const activeEnv: QaSuiteEnvironment = {
      lab,
      mock: activeMock,
      gateway: activeGateway,
      runtimeId: params?.forcedRuntime ?? "openclaw",
      outputDir,
      // YAML scenarios should see the full staged gateway config, not just
      // the transport fragment. Routing/session/plugin assertions depend on it.
      cfg: activeGateway.cfg,
      transport,
      repoRoot,
      providerMode,
      primaryModel,
      alternateModel,
      webSessionIds: new Set(),
    };
    env = activeEnv;

    // Lifecycle scenarios deliberately start a blocked channel. Waiting for
    // connected-channel readiness here would prevent those scenarios from running.
    if (!gatewayRuntimeOptions?.allowUnhealthyStartup) {
      const transportReadyTimeoutMs = resolveQaSuiteTransportReadyTimeoutMs(
        params?.transportReadyTimeoutMs,
      );
      // The gateway child already waits for /readyz before returning, but the
      // selected transport can still be finishing account startup. Pay that
      // readiness cost once here so the first scenario does not race bootstrap.
      await waitForTransportReady(activeEnv, transportReadyTimeoutMs).catch(async () => {
        await waitForGatewayHealthy(activeEnv, transportReadyTimeoutMs);
        await waitForTransportReady(activeEnv, transportReadyTimeoutMs);
      });
    }
    const scenarios: QaSuiteScenarioResult[] = [];
    let runtimeParityCellTiming: QaRuntimeParityCellTiming | undefined;
    const progress = createQaSuiteProgressController({
      lab,
      scenarios: selectedScenarios,
      startedAt: startedAt.toISOString(),
    });
    progress.start();

    const gatewayProcessRssSamples: QaSuiteGatewayRssSample[] = [];
    const sampleGatewayProcessRss = (label: string) => {
      const gatewayProcessRssBytes = activeGateway.getProcessRssBytes?.() ?? null;
      if (gatewayProcessRssBytes !== null) {
        gatewayProcessRssSamples.push({
          label,
          at: new Date().toISOString(),
          gatewayProcessRssBytes,
        });
      }
      return gatewayProcessRssBytes;
    };
    const gatewayProcessCpuStartMs = activeGateway.getProcessCpuMs?.() ?? null;
    const gatewayProcessRssStartBytes = sampleGatewayProcessRss("suite-start");
    const gatewayHeapSnapshots: QaSuiteGatewayHeapSnapshot[] = [];
    const captureGatewayHeapCheckpoint = async (label: string) => {
      if (!gatewayHeapCheckpointsEnabled) {
        return;
      }
      const snapshot = await captureGatewayHeapSnapshotCheckpoint({
        gateway: activeGateway,
        outputDir,
        label,
      });
      if (snapshot) {
        gatewayHeapSnapshots.push(snapshot);
      }
    };
    await captureGatewayHeapCheckpoint("suite-start");
    for (const [index, scenario] of selectedScenarios.entries()) {
      startedScenarioIds.push(scenario.id);
      const scenarioIdForLog = sanitizeQaSuiteProgressValue(scenario.id);
      writeQaSuiteProgress(
        progressEnabled,
        `scenario start (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}`,
      );
      sampleGatewayProcessRss(`scenario:${scenario.id}:start`);
      progress.markRunning([index]);

      const scenarioBootstrapFinishedAt = new Date();
      let scenarioExecutionStartedAt = scenarioBootstrapFinishedAt;
      let scenarioExecutionFinishedAt = scenarioBootstrapFinishedAt;
      let previousAttempt = recording.invocation.previousFailure(index);
      const recorded: { selected?: QaSuiteScenarioResult } = {};
      const runObservedScenario = async () => {
        // Retry backoff and unsuccessful attempts are not part of the final
        // runtime turn, and they must not be relabeled as gateway bootstrap.
        scenarioExecutionStartedAt = new Date();
        const id = recording.invocation.begin(index, previousAttempt);
        let result: QaSuiteScenarioResult;
        try {
          result = await runScenarioDefinition(activeEnv, scenario);
        } catch (error) {
          await recording.record(
            index,
            id,
            {
              name: scenario.title,
              status: "fail",
              details: String(error),
              steps: [],
            },
            { diagnostic: true, env: activeEnv, selectedId: previousAttempt ?? id },
          );
          throw error;
        } finally {
          scenarioExecutionFinishedAt = new Date();
        }
        recorded.selected = await recording.record(index, id, result, {
          env: activeEnv,
          selectedId: previousAttempt !== null && result.status !== "pass" ? previousAttempt : id,
        });
        previousAttempt = id;
        // Flake retry follows this attempt, not a retained failure from an
        // earlier invocation. Reporting still uses the owner's selected result.
        return { ...result, evidenceOccurrenceId: id };
      };
      const scenarioRetryCount =
        scenario.execution.kind === "flow" ? scenario.execution.retryCount : undefined;
      let scenarioResult: QaSuiteScenarioResult =
        params?.captureRuntimeParityCell || scenarioRetryCount === 0
          ? await runObservedScenario()
          : await runQaScenarioWithFlakeRetry(runObservedScenario, () => {
              // Both attempts share append-only Gateway logs. Retain the failed
              // attempt through final cleanup even when its retry passes.
              preserveGatewayRuntimeDir = path.join(outputDir, "artifacts", "gateway-runtime");
              writeQaSuiteProgress(
                progressEnabled,
                `scenario retry (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}`,
              );
            });
      if (
        recorded.selected &&
        recorded.selected.evidenceOccurrenceId !== scenarioResult.evidenceOccurrenceId
      ) {
        scenarioResult = recorded.selected;
      }
      if (scenarioResult.status === "pass" && params?.roundTripProbe?.scenarioId === scenario.id) {
        const probeOccurrenceId = recording.invocation.begin(index, null, { diagnostic: true });
        let probeResult: Awaited<ReturnType<typeof runQaSuiteRoundTripProbe>>;
        try {
          probeResult = await runQaSuiteRoundTripProbe({
            probe: params.roundTripProbe,
            transport,
          });
        } catch (error) {
          await recording.record(
            index,
            probeOccurrenceId,
            {
              name: scenario.title,
              status: "fail",
              details: String(error),
              steps: [],
            },
            { diagnostic: true, env: activeEnv },
          );
          throw error;
        }
        const probePassed = probeResult.passed >= params.roundTripProbe.count;
        scenarioResult = {
          ...scenarioResult,
          status: probePassed ? "pass" : "fail",
          details: [scenarioResult.details, probeResult.details].filter(Boolean).join(" | "),
          timing: probeResult.timing,
          steps: [
            ...scenarioResult.steps,
            {
              name: "Round-trip samples",
              status: probePassed ? "pass" : "fail",
              details: probeResult.details,
            },
          ],
        };
        scenarioResult = await recording.record(index, probeOccurrenceId, scenarioResult, {
          diagnostic: true,
          env: activeEnv,
        });
      }
      if (params?.captureRuntimeParityCell && selectedScenarios.length === 1) {
        runtimeParityCellTiming = measureRuntimeParityCellTiming({
          suiteStartedAt: startedAt,
          bootstrapFinishedAt: scenarioBootstrapFinishedAt,
          scenarioStartedAt: scenarioExecutionStartedAt,
          scenarioFinishedAt: scenarioExecutionFinishedAt,
        });
      }
      sampleGatewayProcessRss(`scenario:${scenario.id}:finish`);
      scenarios.push(scenarioResult);
      writeQaSuiteProgress(
        progressEnabled,
        `scenario ${scenarioResult.status} (${index + 1}/${selectedScenarios.length}): ${scenarioIdForLog}${formatQaScenarioFailureSuffix(scenarioResult)}`,
      );
      progress.recordScenarioResult(index, scenarioResult);
      if (params?.failFast === true && scenarioResult.status === "fail") {
        break;
      }
    }

    const runtimeParityScenario = scenarios[0];
    const runtimeParityCell =
      params?.captureRuntimeParityCell &&
      params.forcedRuntime &&
      selectedScenarios.length === 1 &&
      runtimeParityScenario &&
      runtimeParityCellTiming
        ? await captureRuntimeParityCell({
            runtime: params.forcedRuntime,
            gateway: activeGateway,
            scenarioResult: runtimeParityScenario,
            ...runtimeParityCellTiming,
            mockBaseUrl: activeMock?.baseUrl,
          })
        : undefined;
    const scenarioFinishedAt = new Date();
    await captureGatewayHeapCheckpoint("suite-finish");
    const metrics = buildQaSuiteRuntimeMetrics({
      startedAt,
      finishedAt: scenarioFinishedAt,
      gatewayProcessCpuStartMs,
      gatewayProcessCpuEndMs: activeGateway.getProcessCpuMs?.() ?? null,
      gatewayProcessRssStartBytes,
      gatewayProcessRssEndBytes: sampleGatewayProcessRss("suite-finish"),
      gatewayProcessRssSamples,
      gatewayHeapSnapshots,
    });
    const failedCount = scenarios.filter((scenario) => scenario.status === "fail").length;
    const skippedCount = scenarios.filter((scenario) => scenario.status === "skip").length;
    if (
      scenarios.some((scenario) => scenario.status === "fail") ||
      gatewayRuntimeOptions?.preserveDebugArtifacts === true
    ) {
      preserveGatewayRuntimeDir = path.join(outputDir, "artifacts", "gateway-runtime");
    }
    terminalScenarios = scenarios;
    completionProgress = `run complete: passed=${scenarios.length - failedCount - skippedCount} failed=${failedCount} skipped=${skippedCount} total=${scenarios.length}`;
    publishTerminalResult = async () => {
      const finishedAt = new Date();
      const { evidence, evidencePath, report, reportPath, summaryPath } =
        await writeQaSuiteArtifacts({
          repoRoot,
          outputDir,
          startedAt,
          finishedAt,
          scenarios,
          metrics,
          scenarioDefinitions: selectedScenarios,
          evidenceMode: params?.evidenceMode,
          recordedEvidence: recording.snapshot(),
          transport,
          providerMode,
          primaryModel,
          alternateModel,
          fastMode,
          concurrency,
          channel: params?.channelId ?? transport.id,
          channelDriver: transportFactoryResult.driver,
          publishTransportArtifacts: !isQaSuiteNestedRun(params),
          isolatedWorkers: false,
          writeEvidenceFile: params?.writeEvidenceFile,
          // Same "filtered → executed list, unfiltered → null" convention as
          // the concurrent-path writeQaSuiteArtifacts call above.
          scenarioIds:
            params?.scenarioIds && params.scenarioIds.length > 0
              ? selectedScenarios.map((scenario) => scenario.id)
              : undefined,
        });
      lab.setLatestReport({
        outputPath: reportPath,
        markdown: report,
        generatedAt: finishedAt.toISOString(),
      } satisfies QaLabLatestReport);
      progress.complete([], finishedAt.toISOString());
      return {
        outputDir,
        evidence,
        evidencePath,
        reportPath,
        summaryPath,
        report,
        scenarios,
        startedScenarioIds,
        watchUrl: lab.baseUrl,
        ...(runtimeParityCell ? { runtimeParityCell } : {}),
      } satisfies QaSuiteResult;
    };
  } catch (error) {
    runFailed = true;
    runError = error;
    preserveGatewayRuntimeDir = path.join(outputDir, "artifacts", "gateway-runtime");
    throw error;
  } finally {
    const activeEnv = env;
    const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1" || false;
    const activeGateway = gateway;
    const activeMock = mock;
    const cleanupFailures = await runQaFlowSuiteCleanupPlan({
      closeWebSessions: activeEnv ? () => closeQaWebSessions(activeEnv.webSessionIds) : undefined,
      cleanupTransportBeforeGatewayStop: () => transportFactoryResult.cleanupBeforeGatewayStop(),
      cleanupTransportAfterGatewayStop: () => transportFactoryResult.cleanupAfterGatewayStop(),
      stopGateway: () =>
        activeGateway.stop({
          keepTemp,
          preserveToDir: keepTemp ? undefined : preserveGatewayRuntimeDir,
        }),
      disposeAgentHarnesses: () => disposeRegisteredAgentHarnesses(),
      stopProvider: activeMock ? () => activeMock.stop() : undefined,
      finishLab: ownsLab
        ? () => lab.stop()
        : async () => {
            if (controlUiEnabled) {
              lab.setControlUi({
                controlUiUrl: null,
                controlUiProxyTarget: null,
              });
            }
          },
    });
    throwQaSuiteCleanupErrors({
      cleanupFailures,
      runFailed,
      runError,
      scenarios: terminalScenarios,
    });
  }
  if (!publishTerminalResult || !completionProgress) {
    throw new Error("QA suite completed without terminal result metadata");
  }
  const result = await publishTerminalResult();
  if (!params?.captureRuntimeParityCell && !isQaSuiteNestedRun(params)) {
    writeQaSuiteProgress(progressEnabled, completionProgress);
  }
  return result;
}
