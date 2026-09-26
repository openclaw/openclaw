import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { resolveModelRefFromString } from "openclaw/plugin-sdk/agent-runtime";
import { formatErrorMessage as formatQaErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { formatMemoryDreamingDay } from "openclaw/plugin-sdk/memory-core-host-status";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-host-core";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import * as browserRuntime from "./browser-runtime.js";
import * as cronRunWait from "./cron-run-wait.js";
import * as discoveryEval from "./discovery-eval.js";
import { combineQaSuiteErrors, QaSuiteScenarioSkipError } from "./errors.js";
import * as extractToolPayload from "./extract-tool-payload.js";
import { assertNoGatewayLogSentinels, scanGatewayLogSentinels } from "./gateway-log-sentinel.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import * as modelSwitchEval from "./model-switch-eval.js";
import * as runtimeToolFixture from "./runtime-tool-fixture.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { createQaScenarioRuntimeApi, type QaScenarioRuntimeEnv } from "./scenario-runtime-api.js";
import * as suiteRuntimeAgent from "./suite-runtime-agent.js";
import * as suiteRuntimeGateway from "./suite-runtime-gateway.js";
import * as suiteRuntimeTransport from "./suite-runtime-transport.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import type { QaSuiteScenarioResult, QaSuiteStep } from "./suite-types.js";
import { resolveQaGatewayTimeoutWithGraceMs } from "./timer-timeouts.js";
import * as webRuntime from "./web-runtime.js";

type QaSuiteScenarioFlowEnv = {
  lab: unknown;
  webSessionIds: Set<string>;
  transport: QaSuiteRuntimeEnv["transport"] & QaScenarioRuntimeEnv["transport"];
} & Omit<QaSuiteRuntimeEnv, "transport">;

const qaSuiteScenarioIdentityDeps = {
  fs,
  path,
  randomUUID,
  ...suiteRuntimeAgent,
  ...suiteRuntimeGateway,
  ...suiteRuntimeTransport,
  ...extractToolPayload,
  waitForCronRunCompletion: cronRunWait.waitForCronRunCompletion,
  hasDiscoveryLabels: discoveryEval.hasDiscoveryLabels,
  reportsDiscoveryScopeLeak: discoveryEval.reportsDiscoveryScopeLeak,
  reportsMissingDiscoveryFiles: discoveryEval.reportsMissingDiscoveryFiles,
  hasModelSwitchContinuitySignal: modelSwitchEval.hasModelSwitchContinuitySignal,
  formatMemoryDreamingDay,
  resolveSessionTranscriptsDirForAgent,
  buildAgentSessionKey,
  normalizeLowercaseStringOrEmpty,
};

export async function runQaSuiteScenarioSteps(
  name: string,
  steps: QaSuiteStep[],
): Promise<QaSuiteScenarioResult> {
  const stepResults: QaSuiteScenarioResult["steps"] = [];
  let timing: QaSuiteScenarioResult["timing"];
  let rttMeasurement: QaSuiteScenarioResult["rttMeasurement"];
  for (const step of steps) {
    try {
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] start scenario="${name}" step="${step.name}"`);
      }
      const outcome = await step.run();
      const details = outcome?.details;
      if (outcome?.timing) {
        timing ??= {};
        Object.assign(timing, outcome.timing);
      }
      if (outcome?.rttMeasurement) {
        rttMeasurement = outcome.rttMeasurement;
      }
      if (rttMeasurement) {
        timing ??= {};
        timing.rttMs = rttMeasurement.finalMatchedReplyRttMs;
      }
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] pass scenario="${name}" step="${step.name}"`);
      }
      stepResults.push({
        name: step.name,
        status: "pass",
        ...(details ? { details } : {}),
      });
    } catch (error) {
      const details = formatQaErrorMessage(error);
      const status = error instanceof QaSuiteScenarioSkipError ? "skip" : "fail";
      if (status === "fail" && process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] fail scenario="${name}" step="${step.name}" details=${details}`);
      }
      stepResults.push({ name: step.name, status, details });
      return {
        name,
        status,
        steps: stepResults,
        details,
        ...(timing ? { timing } : {}),
        ...(rttMeasurement ? { rttMeasurement } : {}),
      };
    }
  }
  return {
    name,
    status: "pass",
    steps: stepResults,
    ...(timing ? { timing } : {}),
    ...(rttMeasurement ? { rttMeasurement } : {}),
  };
}

type QaSuiteScenarioDepsParams = {
  env: QaSuiteScenarioFlowEnv;
  runScenario: (name: string, steps: QaSuiteStep[]) => Promise<QaSuiteScenarioResult>;
  splitModelRef: (ref: string) => { provider: string; model: string } | null;
  formatErrorMessage: (error: unknown) => string;
  liveTurnTimeoutMs: (
    env: Pick<QaSuiteRuntimeEnv, "providerMode" | "primaryModel" | "alternateModel">,
    fallbackMs: number,
  ) => number;
  resolveQaLiveTurnTimeoutMs: (
    env: Pick<QaSuiteRuntimeEnv, "providerMode" | "primaryModel" | "alternateModel">,
    fallbackMs: number,
  ) => number;
};

type QaSuiteScenarioFlowApiParams = QaSuiteScenarioDepsParams & {
  scenario: QaSeedScenarioWithSource;
  constants: {
    imageUnderstandingPngBase64: string;
    imageUnderstandingLargePngBase64: string;
    imageUnderstandingValidPngBase64: string;
  };
};

function createQaSuiteScenarioDeps(
  params: QaSuiteScenarioDepsParams,
  webOpenPage: ReturnType<typeof webRuntime.createQaWebPageOpener>,
) {
  const waitForAccountOutboundMessage: typeof suiteRuntimeTransport.waitForOutboundMessage = (
    state,
    predicate,
    timeoutMs,
    options,
  ) =>
    suiteRuntimeTransport.waitForOutboundMessage(state, predicate, timeoutMs, {
      ...options,
      accountId: params.env.transport.accountId,
      signal: params.env.signal,
    });
  const markLogs = params.env.gateway.markLogs;
  const readLogsSince = params.env.gateway.readLogsSince;
  let monotonicGatewayLogs =
    typeof markLogs === "function" && typeof readLogsSince === "function"
      ? { mark: markLogs, readSince: readLogsSince }
      : undefined;
  const isValidGatewayLogMark = (mark: number | undefined): mark is number =>
    Number.isSafeInteger(mark) && (mark ?? -1) >= 0;
  const fullLegacyGatewayLogSnapshotMark = -1;
  const readGatewayLogs = (mark?: number) => {
    if (monotonicGatewayLogs && isValidGatewayLogMark(mark)) {
      return monotonicGatewayLogs.readSince(mark);
    }
    return params.env.gateway.logs?.() ?? "";
  };
  const readGatewayLogsForSentinels = (options?: Parameters<typeof scanGatewayLogSentinels>[1]) => {
    if (monotonicGatewayLogs && isValidGatewayLogMark(options?.since)) {
      return {
        logs: monotonicGatewayLogs.readSince(options.since),
        options: { ...options, since: 0 },
      };
    }
    return {
      logs: params.env.gateway.logs?.(),
      options: { ...options, since: 0 },
    };
  };
  return {
    ...qaSuiteScenarioIdentityDeps,
    sleep: (ms?: number) => sleep(ms, undefined, { signal: params.env.signal }),
    runScenario: params.runScenario,
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
    markGatewayLogCursor: () => {
      if (monotonicGatewayLogs) {
        const mark = monotonicGatewayLogs.mark();
        if (isValidGatewayLogMark(mark)) {
          return mark;
        }
        monotonicGatewayLogs = undefined;
        return fullLegacyGatewayLogSnapshotMark;
      }
      return fullLegacyGatewayLogSnapshotMark;
    },
    scanGatewayLogSentinels: (options?: Parameters<typeof scanGatewayLogSentinels>[1]) => {
      const input = readGatewayLogsForSentinels(options);
      return scanGatewayLogSentinels(input.logs, input.options);
    },
    assertNoGatewayLogSentinels: (options?: Parameters<typeof assertNoGatewayLogSentinels>[1]) => {
      const input = readGatewayLogsForSentinels(options);
      return assertNoGatewayLogSentinels(input.logs, input.options);
    },
    runRuntimeToolFixture: async (
      envArg: QaSuiteScenarioFlowEnv,
      configArg: Record<string, unknown>,
    ) =>
      runtimeToolFixture.runRuntimeToolFixture(envArg, configArg, {
        createSession: suiteRuntimeAgent.createSession,
        readEffectiveTools: suiteRuntimeAgent.readEffectiveTools,
        runAgentPrompt: suiteRuntimeAgent.runAgentPrompt,
        fetchJson: suiteRuntimeGateway.fetchJson,
        ensureImageGenerationConfigured: suiteRuntimeAgent.ensureImageGenerationConfigured,
      }),
    formatErrorMessage: params.formatErrorMessage,
    liveTurnTimeoutMs: params.liveTurnTimeoutMs,
    resolveQaLiveTurnTimeoutMs: params.resolveQaLiveTurnTimeoutMs,
    normalizeModelRef: (raw: string) => {
      const split = params.splitModelRef(raw);
      return split
        ? (resolveModelRefFromString({
            cfg: params.env.cfg,
            raw,
            defaultProvider: split.provider,
          })?.ref ?? null)
        : null;
    },
    splitModelRef: params.splitModelRef,
  };
}

function createQaSuiteScenarioFlowApi(
  params: QaSuiteScenarioFlowApiParams & { signal: AbortSignal },
) {
  const createWebPageOpener = (signal?: AbortSignal) => {
    const open = webRuntime.createQaWebPageOpener(params.env.webSessionIds, signal);
    return (webParams: Parameters<typeof webRuntime.qaWebOpenPage>[0]) =>
      open({ ...webParams, repoRoot: params.env.repoRoot });
  };
  const createApi = (signal?: AbortSignal) => {
    const scopedParams = { ...params, env: { ...params.env, signal } };
    return {
      ...createQaScenarioRuntimeApi({
        env: scopedParams.env,
        scenario: params.scenario,
        deps: createQaSuiteScenarioDeps(scopedParams, createWebPageOpener(signal)),
        constants: params.constants,
      }),
      signal,
    };
  };
  // Finally shares resource ownership, not the cancelled environment or helpers.
  // Cleanup may still need transport reads and new pages before the owner closes.
  return { api: createApi(params.signal), cleanupApi: createApi() };
}

function createQaScenarioDeadline(
  timeoutMs?: number,
  whenUnhealthy?: Promise<Error>,
  parentSignal?: AbortSignal,
) {
  const controller = new AbortController();
  const signal = parentSignal
    ? AbortSignal.any([controller.signal, parentSignal])
    : controller.signal;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadlineTimeoutMs = resolveQaGatewayTimeoutWithGraceMs(timeoutMs);
  let disposed = false;
  const interrupt = (error: unknown) => {
    if (!disposed) {
      controller.abort(error);
    }
  };
  void whenUnhealthy?.then(interrupt, interrupt);
  return {
    signal,
    run: async <T>(operation: () => Promise<T>) => {
      signal.throwIfAborted();
      if (deadlineTimeoutMs !== undefined && !timer) {
        // Preparation has a separate budget; start at the first owned operation.
        timer = setTimeout(
          () => controller.abort(new Error(`QA scenario flow timed out after ${timeoutMs}ms`)),
          deadlineTimeoutMs,
        );
      }
      try {
        // Cancellation releases owned resources; it is not proof that the raw
        // operation or its DSL finally has settled. Join both before publication.
        const result = await operation();
        signal.throwIfAborted();
        return result;
      } catch (error) {
        if (
          signal.aborted &&
          error !== signal.reason &&
          !(error instanceof AggregateError && error.errors.includes(signal.reason))
        ) {
          throw combineQaSuiteErrors(
            [signal.reason, error],
            `QA flow interrupted: ${formatQaErrorMessage(signal.reason)}; operation failed: ${formatQaErrorMessage(error)}`,
            { cause: signal.reason },
          );
        }
        throw error;
      }
    },
    dispose: () => {
      disposed = true;
      clearTimeout(timer);
    },
  };
}

function createQaSuiteScenarioStepRunner(
  env: QaSuiteScenarioFlowEnv,
  scenario: QaSeedScenarioWithSource,
  vars: Record<string, unknown>,
  deadline: ReturnType<typeof createQaScenarioDeadline>,
  deps: {
    liveTurnTimeoutMs: QaSuiteScenarioDepsParams["liveTurnTimeoutMs"];
    runScenario: QaSuiteScenarioDepsParams["runScenario"];
  } = {
    liveTurnTimeoutMs: resolveQaLiveTurnTimeoutMs,
    runScenario: runQaSuiteScenarioSteps,
  },
): QaSuiteScenarioDepsParams["runScenario"] {
  const prepareFlow = env.transport.prepareFlow;
  const execution = scenario.execution;
  return async (name, steps) => {
    const scenarioSteps = steps.map((step) =>
      Object.assign({}, step, { run: async () => await deadline.run(step.run) }),
    );
    const preparedSteps =
      prepareFlow && execution.kind === "flow"
        ? [
            {
              name: `Prepare ${env.transport.label}`,
              run: async () => {
                const fallbackTimeoutMs = deps.liveTurnTimeoutMs(env, 60_000);
                const preparationDeadline = createQaScenarioDeadline(
                  Math.max(execution.timeoutMs ?? 0, fallbackTimeoutMs),
                  env.transport.whenUnhealthy,
                  deadline.signal,
                );
                try {
                  const prepared = await preparationDeadline.run(() =>
                    prepareFlow({
                      signal: preparationDeadline.signal,
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
    return await deps.runScenario(name, preparedSteps);
  };
}

export async function runQaSuiteScenarioDefinition(params: QaSuiteScenarioFlowApiParams) {
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
    params.env.signal,
  );
  try {
    const { api, cleanupApi } = createQaSuiteScenarioFlowApi({
      ...params,
      signal: deadline.signal,
      runScenario: createQaSuiteScenarioStepRunner(params.env, params.scenario, vars, deadline, {
        liveTurnTimeoutMs: params.liveTurnTimeoutMs,
        runScenario: params.runScenario,
      }),
    });
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
