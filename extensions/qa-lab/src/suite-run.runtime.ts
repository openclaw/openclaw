import path from "node:path";
import {
  defaultQaSuiteConcurrencyForTransport,
  normalizeQaTransportId,
  prepareQaTransportAdapterFactories,
  qaTransportSupportsModuleFlows,
} from "./qa-transport-registry.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { expandQaScenarioExecutionCells } from "./scenario-lane.js";
import { invalidateQaSuiteArtifactGeneration } from "./suite-artifacts.js";
import { resolveRequestedQaSuiteModels } from "./suite-model-selection.js";
import {
  collectQaSuiteGatewayConfigPatches,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuitePluginIds,
  normalizeQaSuiteConcurrency,
  resolveQaSuiteOutputDir,
  selectQaFlowSuiteScenarios,
} from "./suite-planning.js";
import { runQaFlowSuiteIsolated } from "./suite-run-isolated.js";
import { runQaFlowSuiteStandard } from "./suite-run-standard.js";
import { runQaRuntimeParitySuite } from "./suite-runtime-parity-runner.js";
import { shouldCaptureGatewayHeapCheckpoints } from "./suite-support.js";
import type { QaSuiteResolvedRunContext, QaSuiteResult, QaSuiteRunParams } from "./suite-types.js";
import {
  formatQaSuiteRunStartProgress,
  isQaSuiteNestedRun,
  markQaSuiteNestedRun,
  runQaSuiteScenarioDefinitionForRuntime,
  shouldLogQaSuiteProgress,
  shouldRunQaSuiteWithIsolatedScenarioWorkers,
  writeQaSuiteProgress,
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
      `QA round-trip probe scenario is not selected: ${params.roundTripProbe.scenarioId}`,
    );
  }
  if (params?.roundTripProbe && params.runtimePair) {
    throw new Error("QA round-trip probes are not supported with runtime-pair runs.");
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
        channelDriver === "crabline" ? 1 : defaultQaSuiteConcurrencyForTransport(transportId),
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
    return await runQaRuntimeParitySuite({
      ...preparedParams,
      ...context,
      runQaFlowSuite: runQaFlowSuiteFromRuntime,
      // Each parity child adds its scenario plugins during its own preparation.
      enabledPluginIds: params.enabledPluginIds,
      runtimePair: params.runtimePair,
    });
  }
  return useIsolatedScenarioWorkers
    ? await runQaFlowSuiteIsolated(preparedParams, context, runQaFlowSuiteFromRuntime)
    : await runQaFlowSuiteStandard(preparedParams, context, runQaSuiteScenarioDefinitionForRuntime);
}
