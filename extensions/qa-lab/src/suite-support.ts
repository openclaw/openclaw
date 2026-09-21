import { parseBooleanValue } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { QaProviderMode } from "./model-selection.js";
import type { QaTransportId } from "./qa-transport-registry.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import type { RuntimeId } from "./runtime-parity.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import type { QaScorecardChannelDriver } from "./scorecard-taxonomy.js";
import { scenarioRequiresControlUi, splitModelRef } from "./suite-planning.js";
import type { QaSuiteRunParams, QaSuiteScenarioResult, QaSuiteStartLabFn } from "./suite-types.js";

/**
 * One bounded retry for live-model flake: flow scenarios time out under model
 * latency spikes, so a first failure gets a single rerun. A retry pass keeps
 * the first attempt visible in details; a retry failure keeps the original
 * diagnostics so deterministic regressions still fail the suite.
 */
export async function runQaScenarioWithFlakeRetry(
  run: () => Promise<QaSuiteScenarioResult>,
  onRetry?: () => void,
): Promise<QaSuiteScenarioResult> {
  const first = await run();
  if (first.status !== "fail") {
    return first;
  }
  onRetry?.();
  const second = await run();
  if (second.status !== "pass") {
    return first;
  }
  return {
    ...second,
    details: [second.details, `passed on retry; first attempt: ${first.details ?? "failed"}`]
      .filter(Boolean)
      .join(" | "),
  };
}

export function createQaSuiteReportNotes(params: {
  transport: QaTransportAdapter;
  transportArtifactNotes?: readonly string[];
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
  isolatedWorkers?: boolean;
}) {
  return [...params.transport.createReportNotes(params), ...(params.transportArtifactNotes ?? [])];
}

export function buildQaIsolatedScenarioWorkerParams(params: {
  repoRoot: string;
  outputDir: string;
  providerMode: QaProviderMode;
  transportId: QaTransportId;
  channelDriver?: QaScorecardChannelDriver;
  channelId?: string;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];
  input?: QaSuiteRunParams;
  startLab: QaSuiteStartLabFn;
}): QaSuiteRunParams {
  return {
    adapterFactories: params.input?.adapterFactories,
    adapterOptions: params.input?.adapterOptions,
    channelId: params.channelId ?? params.input?.channelId,
    evidenceMode: params.input?.evidenceMode,
    repoRoot: params.repoRoot,
    sutOpenClawCommand: params.input?.sutOpenClawCommand,
    mutateConfig: params.input?.mutateConfig,
    outputDir: params.outputDir,
    providerMode: params.providerMode,
    transportId: params.transportId,
    channelDriver: params.channelDriver,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
    fastMode: params.fastMode,
    thinkingDefault: params.input?.thinkingDefault,
    claudeCliAuthMode: params.input?.claudeCliAuthMode,
    scenarioIds: [params.scenario.id],
    enabledPluginIds: params.input?.enabledPluginIds,
    concurrency: 1,
    startLab: params.startLab,
    controlUiEnabled: params.input?.controlUiEnabled ?? scenarioRequiresControlUi(params.scenario),
    transportReadyTimeoutMs: params.input?.transportReadyTimeoutMs,
    workerStartStaggerMs: params.input?.workerStartStaggerMs,
    forcedRuntime: params.input?.forcedRuntime,
    roundTripProbe:
      params.input?.roundTripProbe?.scenarioId === params.scenario.id
        ? params.input.roundTripProbe
        : undefined,
    writeEvidenceFile: params.input?.writeEvidenceFile,
  };
}

export function remapModelRefForForcedRuntime(params: {
  modelRef: string;
  providerMode: QaProviderMode;
  forcedRuntime?: RuntimeId;
}) {
  if (params.forcedRuntime !== "codex" || params.providerMode !== "mock-openai") {
    return params.modelRef;
  }
  const split = splitModelRef(params.modelRef);
  if (!split || split.provider !== "mock-openai") {
    return params.modelRef;
  }
  return `openai/${split.model}`;
}

function appendNodeOption(raw: string | undefined, option: string) {
  const parts = (raw ?? "").split(/\s+/u).filter(Boolean);
  return parts.includes(option) ? parts.join(" ") : [...parts, option].join(" ");
}

export function shouldCaptureGatewayHeapCheckpoints(env: NodeJS.ProcessEnv = process.env) {
  return parseBooleanValue(env.OPENCLAW_QA_GATEWAY_HEAP_CHECKPOINTS) === true;
}

export function buildQaGatewayHeapCheckpointRuntimeEnvPatch(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv | undefined {
  if (!shouldCaptureGatewayHeapCheckpoints(env)) {
    return undefined;
  }
  return {
    NODE_OPTIONS: appendNodeOption(env.NODE_OPTIONS, "--heapsnapshot-signal=SIGQUIT"),
  };
}

export function mergeQaRuntimeEnvPatches(
  ...patches: Array<NodeJS.ProcessEnv | undefined>
): NodeJS.ProcessEnv | undefined {
  const merged: NodeJS.ProcessEnv = {};
  for (const patch of patches) {
    if (!patch) {
      continue;
    }
    Object.assign(merged, patch);
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}
