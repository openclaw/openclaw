import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import { formatErrorMessage as formatQaErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-host-core";
import { buildAgentSessionKey, resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { extractToolPayload as extractQaToolPayload } from "openclaw/plugin-sdk/tool-payload";
import * as browserRuntime from "./browser-runtime.js";
import * as cronRunWait from "./cron-run-wait.js";
import * as discoveryEval from "./discovery-eval.js";
import { QaSuiteScenarioSkipError } from "./errors.js";
import {
  inspectQaExecutionIdentityStorage,
  readNativeQaSubagentRuns,
} from "./execution-identity-storage-inspection.js";
import {
  assertNoGatewayLogSentinels,
  formatGatewayLogSentinelSummary,
  scanGatewayLogSentinels,
} from "./gateway-log-sentinel.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import { splitQaModelRef } from "./model-selection.js";
import * as modelSwitchEval from "./model-switch-eval.js";
import { runQaCli } from "./qa-cli-process.js";
import * as runtimeToolFixture from "./runtime-tool-fixture.js";
import {
  formatToolSearchDiscoveryReceipt,
  requireToolSearchDiscoveryEvidence,
} from "./runtime-tool-search-evidence.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import * as suiteRuntimeAgentMedia from "./suite-runtime-agent-media.js";
import * as suiteRuntimeAgentProcess from "./suite-runtime-agent-process.js";
import * as suiteRuntimeAgentSession from "./suite-runtime-agent-session.js";
import {
  callPluginToolsMcp,
  findSkill,
  handleQaAction,
  writeWorkspaceSkill,
} from "./suite-runtime-agent-tools.js";
import * as suiteRuntimeGateway from "./suite-runtime-gateway.js";
import * as suiteRuntimeTransport from "./suite-runtime-transport.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import type { QaSuiteScenarioResult, QaSuiteStep } from "./suite-types.js";
import { resolveQaGatewayTimeoutWithGraceMs } from "./timer-timeouts.js";
import { projectQaToolMessages } from "./tool-activity.js";
import * as webRuntime from "./web-runtime.js";

type QaSuiteScenarioFlowEnv = {
  lab: unknown;
  webSessionIds: Set<string>;
} & QaSuiteRuntimeEnv;

const qaSuiteScenarioIdentityDeps = {
  fs,
  path,
  sleep,
  randomUUID,
  projectQaToolMessages,
  // YAML scenarios resolve these bindings by name; keep the registry statically visible.
  ensureImageGenerationConfigured: suiteRuntimeAgentMedia.ensureImageGenerationConfigured,
  extractMediaPathFromText: suiteRuntimeAgentMedia.extractMediaPathFromText,
  resolveGeneratedImagePath: suiteRuntimeAgentMedia.resolveGeneratedImagePath,
  findManagedDreamingCronJob: suiteRuntimeAgentProcess.findManagedDreamingCronJob,
  forceMemoryIndex: suiteRuntimeAgentProcess.forceMemoryIndex,
  listCronJobs: suiteRuntimeAgentProcess.listCronJobs,
  readDoctorMemoryStatus: suiteRuntimeAgentProcess.readDoctorMemoryStatus,
  runAgentPrompt: suiteRuntimeAgentProcess.runAgentPrompt,
  startAgentRun: suiteRuntimeAgentProcess.startAgentRun,
  waitForAgentHistory: suiteRuntimeAgentProcess.waitForAgentHistory,
  waitForAgentHistoryReply: suiteRuntimeAgentProcess.waitForAgentHistoryReply,
  waitForAgentRun: suiteRuntimeAgentProcess.waitForAgentRun,
  createSession: suiteRuntimeAgentSession.createSession,
  readEffectiveTools: suiteRuntimeAgentSession.readEffectiveTools,
  readQaSessionTranscriptEvents: suiteRuntimeAgentSession.readQaSessionTranscriptEvents,
  readRawQaSessionStore: suiteRuntimeAgentSession.readRawQaSessionStore,
  readSessionToolActivity: suiteRuntimeAgentSession.readSessionToolActivity,
  readSessionTranscriptSummary: suiteRuntimeAgentSession.readSessionTranscriptSummary,
  readSkillStatus: suiteRuntimeAgentSession.readSkillStatus,
  readSubagentHandoffReply: suiteRuntimeAgentSession.readSubagentHandoffReply,
  seedQaSessionEntries: suiteRuntimeAgentSession.seedQaSessionEntries,
  seedQaSessionTranscript: suiteRuntimeAgentSession.seedQaSessionTranscript,
  callPluginToolsMcp,
  findSkill,
  handleQaAction,
  writeWorkspaceSkill,
  runQaCli,
  inspectQaExecutionIdentityStorage,
  readNativeQaSubagentRuns,
  ...suiteRuntimeGateway,
  ...suiteRuntimeTransport,
  extractQaToolPayload,
  waitForCronRunCompletion: cronRunWait.waitForCronRunCompletion,
  hasDiscoveryLabels: discoveryEval.hasDiscoveryLabels,
  reportsDiscoveryScopeLeak: discoveryEval.reportsDiscoveryScopeLeak,
  reportsMissingDiscoveryFiles: discoveryEval.reportsMissingDiscoveryFiles,
  hasModelSwitchContinuitySignal: modelSwitchEval.hasModelSwitchContinuitySignal,
  formatMemoryDreamingDay,
  resolveSessionTranscriptsDirForAgent,
  buildAgentSessionKey,
  resolveAgentRoute,
  normalizeLowercaseStringOrEmpty,
  formatToolSearchDiscoveryReceipt,
  requireToolSearchDiscoveryEvidence,
};

const QA_FAILURE_GATEWAY_SENTINEL_LIMIT = 5;

const isValidGatewayLogMark = (mark: number | undefined): mark is number =>
  Number.isSafeInteger(mark) && (mark ?? -1) >= 0;

// Gateway log sentinels often name the cause of a wait timeout (for example a
// channel final reply that failed to deliver) while transport timeouts stay
// content-free. Attach them to the failed step only: parity classifies
// scenario-level details by keyword, and appended log text must not move it.
function appendGatewayLogSentinelEvidence(
  result: QaSuiteScenarioResult,
  gateway: QaSuiteScenarioFlowEnv["gateway"],
  mark: number | undefined,
): QaSuiteScenarioResult {
  const failedStepIndex = result.steps.findIndex((step) => step.status === "fail");
  if (failedStepIndex < 0 || !gateway.readLogsSince || !isValidGatewayLogMark(mark)) {
    return result;
  }
  const findings = scanGatewayLogSentinels(gateway.readLogsSince(mark));
  if (findings.length === 0) {
    return result;
  }
  const omitted = findings.length - QA_FAILURE_GATEWAY_SENTINEL_LIMIT;
  const evidence = [
    "Gateway log sentinel(s) during scenario:",
    formatGatewayLogSentinelSummary(findings.slice(0, QA_FAILURE_GATEWAY_SENTINEL_LIMIT)),
    ...(omitted > 0 ? [`(${omitted} more)`] : []),
  ].join("\n");
  return {
    ...result,
    steps: result.steps.map((step, index) =>
      index === failedStepIndex
        ? { ...step, details: step.details ? `${step.details}\n${evidence}` : evidence }
        : step,
    ),
  };
}

export async function runQaSuiteScenarioSteps(
  name: string,
  steps: QaSuiteStep[],
): Promise<QaSuiteScenarioResult> {
  const result: QaSuiteScenarioResult = { name, status: "pass", steps: [] };
  for (const step of steps) {
    try {
      const outcome = await step.run();
      const details = outcome?.details;
      if (outcome?.timing) {
        result.timing ??= {};
        Object.assign(result.timing, outcome.timing);
      }
      if (outcome?.rttMeasurement) {
        result.rttMeasurement = outcome.rttMeasurement;
      }
      if (result.rttMeasurement) {
        result.timing ??= {};
        result.timing.rttMs = result.rttMeasurement.finalMatchedReplyRttMs;
      }
      result.steps.push({
        name: step.name,
        status: "pass",
        ...(details ? { details } : {}),
      });
    } catch (error) {
      const details = formatQaErrorMessage(error);
      const status = error instanceof QaSuiteScenarioSkipError ? "skip" : "fail";
      result.steps.push({ name: step.name, status, details });
      result.status = status;
      result.details = details;
      break;
    }
  }
  return result;
}

function createQaScenarioDeadline(timeoutMs?: number, whenUnhealthy?: Promise<Error>) {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineTimeoutMs = resolveQaGatewayTimeoutWithGraceMs(timeoutMs);
  let deadline: Promise<never> | undefined;
  let disposed = false;
  const transportFailure = whenUnhealthy?.then((error) => {
    if (!disposed) {
      controller.abort(error);
    }
    throw error;
  });
  // Transport loss may precede the first step; run() still observes the rejection.
  void transportFailure?.catch(() => {});
  return {
    signal: controller.signal,
    run: async <T>(operation: () => Promise<T>) => {
      controller.signal.throwIfAborted();
      if (deadlineTimeoutMs !== undefined) {
        deadline ??= new Promise<never>((_resolve, reject) => {
          const timeoutError = new Error(`QA scenario flow timed out after ${timeoutMs}ms`);
          // Start at this owner's first operation. Preparation has a separate
          // budget and must not consume a scenario's complete observation window.
          timer = setTimeout(() => {
            controller.abort(timeoutError);
            reject(timeoutError);
          }, deadlineTimeoutMs);
        });
      }
      // In-flight calls abort cooperatively. The flow runner fences later actions and
      // preserves DSL finally cleanup; the suite owner then tears down runtime resources.
      const pending = operation();
      const bounded = deadline ? Promise.race([pending, deadline]) : pending;
      return transportFailure ? await Promise.race([bounded, transportFailure]) : await bounded;
    },
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

export async function runQaSuiteScenarioDefinition(params: {
  env: QaSuiteScenarioFlowEnv;
  scenario: QaSeedScenarioWithSource;
  constants: {
    imageUnderstandingPngBase64: string;
    imageUnderstandingLargePngBase64: string;
    imageUnderstandingValidPngBase64: string;
  };
}) {
  if (params.scenario.execution.kind !== "flow") {
    throw new Error(`scenario is not a flow: ${params.scenario.id}`);
  }
  if (!params.scenario.execution.flow) {
    throw new Error(`scenario missing flow: ${params.scenario.id}`);
  }
  const vars: Record<string, unknown> = {};
  const deadline = createQaScenarioDeadline(
    params.scenario.execution.timeoutMs,
    params.env.transport.whenUnhealthy,
  );
  try {
    const { env, scenario } = params;
    const prepareFlow = env.transport.prepareFlow;
    const execution = scenario.execution;
    const runScenario = async (name: string, steps: QaSuiteStep[]) => {
      const gatewayLogMark = env.gateway.markLogs?.();
      const scenarioSteps = steps.map((step) =>
        Object.assign({}, step, { run: async () => await deadline.run(step.run) }),
      );
      const preparedSteps =
        prepareFlow && execution.kind === "flow"
          ? [
              {
                name: `Prepare ${env.transport.label}`,
                run: async () => {
                  const fallbackTimeoutMs = resolveQaLiveTurnTimeoutMs(env, 60_000);
                  const preparationDeadline = createQaScenarioDeadline(
                    Math.max(execution.timeoutMs ?? 0, fallbackTimeoutMs),
                    env.transport.whenUnhealthy,
                  );
                  try {
                    const prepared = await preparationDeadline.run(() =>
                      prepareFlow({
                        signal: AbortSignal.any([preparationDeadline.signal, deadline.signal]),
                        config: execution.config ?? {},
                        gateway: env.gateway,
                        outputDir: env.outputDir,
                        primaryModel: env.primaryModel,
                        scenarioId: scenario.id,
                        scenarioTitle: scenario.title,
                        timeoutMs: execution.timeoutMs ?? fallbackTimeoutMs,
                        waitForConfigRestartSettle: async (options) =>
                          await suiteRuntimeGateway.waitForConfigRestartSettle(
                            env,
                            options?.restartDelayMs,
                            options?.timeoutMs,
                          ),
                      }),
                    );
                    preparationDeadline.signal.throwIfAborted();
                    if (prepared) {
                      Object.assign(vars, prepared);
                    }
                  } finally {
                    preparationDeadline.dispose();
                  }
                },
              },
              ...scenarioSteps,
            ]
          : scenarioSteps;
      const result = await runQaSuiteScenarioSteps(name, preparedSteps);
      return result.status === "fail"
        ? appendGatewayLogSentinelEvidence(result, env.gateway, gatewayLogMark)
        : result;
    };
    const createWebPageOpener = (signal?: AbortSignal) => {
      const open = webRuntime.createQaWebPageOpener(params.env.webSessionIds, signal);
      return (webParams: webRuntime.QaWebOpenPageParams) =>
        open({ ...webParams, repoRoot: params.env.repoRoot });
    };
    const webOpenPage = createWebPageOpener(deadline.signal);
    const waitForAccountOutboundMessage: typeof suiteRuntimeTransport.waitForOutboundMessage = (
      state,
      predicate,
      timeoutMs,
      options,
    ) =>
      suiteRuntimeTransport.waitForOutboundMessage(state, predicate, timeoutMs, {
        ...options,
        accountId: params.env.transport.accountId,
      });
    const markLogs = params.env.gateway.markLogs;
    const readLogsSince = params.env.gateway.readLogsSince;
    const monotonicGatewayLogs =
      typeof markLogs === "function" && typeof readLogsSince === "function"
        ? { mark: markLogs, readSince: readLogsSince }
        : undefined;
    const readGatewayLogs = (mark?: number) => {
      if (monotonicGatewayLogs && isValidGatewayLogMark(mark)) {
        return monotonicGatewayLogs.readSince(mark);
      }
      return params.env.gateway.logs?.() ?? "";
    };
    const deps = {
      ...qaSuiteScenarioIdentityDeps,
      runScenario,
      waitForOutboundMessage: waitForAccountOutboundMessage,
      browserRequest: browserRuntime.callQaBrowserRequest,
      waitForBrowserReady: browserRuntime.waitForQaBrowserReady,
      browserOpenTab: browserRuntime.qaBrowserOpenTab,
      browserSnapshot: browserRuntime.qaBrowserSnapshot,
      browserAct: browserRuntime.qaBrowserAct,
      webOpenPage,
      webWait: webRuntime.qaWebWait,
      webType: webRuntime.qaWebType,
      webSnapshot: webRuntime.qaWebSnapshot,
      webEvaluate: webRuntime.qaWebEvaluate,
      readGatewayLogs,
      markGatewayLogCursor: () => monotonicGatewayLogs?.mark() ?? -1,
      scanGatewayLogSentinels: (options?: Parameters<typeof scanGatewayLogSentinels>[1]) =>
        scanGatewayLogSentinels(readGatewayLogs(options?.since), { ...options, since: 0 }),
      assertNoGatewayLogSentinels: (options?: Parameters<typeof assertNoGatewayLogSentinels>[1]) =>
        assertNoGatewayLogSentinels(readGatewayLogs(options?.since), { ...options, since: 0 }),
      runRuntimeToolFixture: runtimeToolFixture.runRuntimeToolFixture,
      formatErrorMessage: formatQaErrorMessage,
      liveTurnTimeoutMs: resolveQaLiveTurnTimeoutMs,
      resolveQaLiveTurnTimeoutMs,
      normalizeModelRef: (raw: string) => {
        const split = splitQaModelRef(raw);
        return split
          ? (resolveModelRefFromString({
              cfg: params.env.cfg,
              raw,
              defaultProvider: split.provider,
            })?.ref ?? null)
          : null;
      },
      splitModelRef: splitQaModelRef,
    };
    const transport = params.env.transport;
    const transportState = transport.state;
    const resetTransportState = async () => {
      await transport.reset();
    };

    const api = {
      ...deps,
      env: params.env,
      lab: params.env.lab,
      transport,
      state: transportState,
      scenario: params.scenario,
      config: params.scenario.execution.config ?? {},
      waitForCondition: transport.waitForCondition,
      waitForChannelReady: deps.waitForTransportReady,
      waitForQaChannelReady: deps.waitForTransportReady,
      imageUnderstandingPngBase64: params.constants.imageUnderstandingPngBase64,
      imageUnderstandingLargePngBase64: params.constants.imageUnderstandingLargePngBase64,
      imageUnderstandingValidPngBase64: params.constants.imageUnderstandingValidPngBase64,
      getTransportSnapshot: transportState.getSnapshot.bind(transportState),
      resetTransport: resetTransportState,
      injectInboundMessage: transport.sendInbound.bind(transport),
      injectOutboundMessage: transportState.addOutboundMessage.bind(transportState),
      readTransportMessage: transportState.readMessage.bind(transportState),
      resetBus: resetTransportState,
      reset: resetTransportState,
      signal: deadline.signal,
    };
    // DSL finally actions share the suite owner without the expired acquisition signal.
    const cleanupApi = { ...api, webOpenPage: createWebPageOpener() };
    return await runScenarioFlow({
      api,
      cleanupApi,
      flow: params.scenario.execution.flow,
      scenarioTitle: params.scenario.title,
      vars,
    });
  } finally {
    deadline.dispose();
  }
}
