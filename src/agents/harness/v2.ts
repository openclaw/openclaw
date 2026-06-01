import {
  assertContextEngineHostSupport,
  type ContextEngineHostSupport,
} from "../../context-engine/host-compat.js";
import { diagnosticErrorCategory } from "../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  type DiagnosticHarnessRunErrorEvent,
  type DiagnosticHarnessRunOutcome,
} from "../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  getActiveDiagnosticTraceContext,
  runWithDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../infra/diagnostic-trace-context.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { applyAgentHarnessResultClassification } from "./result-classification.js";
import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptResult,
  AgentHarnessCompactParams,
  AgentHarnessCompactResult,
  AgentHarnessResetParams,
  AgentHarnessSupport,
  AgentHarnessSupportContext,
} from "./types.js";

const log = createSubsystemLogger("agents/harness/v2");
type AgentHarnessV2LifecyclePhase = DiagnosticHarnessRunErrorEvent["phase"];
type AgentRunCompletedOutcome = "completed" | "aborted" | "blocked" | "error";
type AgentRunCompletion = {
  outcome: AgentRunCompletedOutcome;
  blockedBy?: string;
  error?: unknown;
};

type AgentHarnessV2RunBase = {
  harnessId: string;
  label: string;
  pluginId?: string;
  params: AgentHarnessAttemptParams;
  contextEngineHost?: ContextEngineHostSupport;
};

export type AgentHarnessV2PreparedRun = AgentHarnessV2RunBase & {
  lifecycleState: "prepared";
};

export type AgentHarnessV2Session = AgentHarnessV2RunBase & {
  lifecycleState: "started";
};

export type AgentHarnessV2ToolCall = {
  id?: string;
  name: string;
  input?: unknown;
};

export type AgentHarnessV2CleanupParams = {
  prepared?: AgentHarnessV2PreparedRun;
  session?: AgentHarnessV2Session;
  result?: AgentHarnessAttemptResult;
  error?: unknown;
};

export type AgentHarnessV2 = {
  id: string;
  label: string;
  pluginId?: string;
  supports(ctx: AgentHarnessSupportContext): AgentHarnessSupport;
  prepare(params: AgentHarnessAttemptParams): Promise<AgentHarnessV2PreparedRun>;
  start(prepared: AgentHarnessV2PreparedRun): Promise<AgentHarnessV2Session>;
  resume?(session: AgentHarnessV2Session): Promise<AgentHarnessV2Session>;
  send(session: AgentHarnessV2Session): Promise<AgentHarnessAttemptResult>;
  handleToolCall?(session: AgentHarnessV2Session, call: AgentHarnessV2ToolCall): Promise<unknown>;
  resolveOutcome(
    session: AgentHarnessV2Session,
    result: AgentHarnessAttemptResult,
  ): Promise<AgentHarnessAttemptResult>;
  cleanup(params: AgentHarnessV2CleanupParams): Promise<void>;
  compact?(params: AgentHarnessCompactParams): Promise<AgentHarnessCompactResult | undefined>;
  reset?(params: AgentHarnessResetParams): Promise<void> | void;
  dispose?(): Promise<void> | void;
};

export function adaptAgentHarnessToV2(harness: AgentHarness): AgentHarnessV2 {
  return {
    id: harness.id,
    label: harness.label,
    pluginId: harness.pluginId,
    supports: (ctx) => harness.supports(ctx),
    prepare: async (params) => ({
      harnessId: harness.id,
      label: harness.label,
      pluginId: harness.pluginId,
      params,
      contextEngineHost: buildAgentHarnessContextEngineHostSupport(harness),
      lifecycleState: "prepared",
    }),
    start: async (prepared) => ({
      harnessId: prepared.harnessId,
      label: prepared.label,
      pluginId: prepared.pluginId,
      params: prepared.params,
      contextEngineHost: prepared.contextEngineHost,
      lifecycleState: "started",
    }),
    send: async (session) => {
      if (session.params.contextEngine && session.params.contextEngine.info.id !== "legacy") {
        assertContextEngineHostSupport({
          contextEngine: session.params.contextEngine,
          operation: "agent-run",
          host: session.contextEngineHost ?? buildAgentHarnessContextEngineHostSupport(harness),
        });
      }
      return harness.runAttempt(session.params);
    },
    resolveOutcome: async (session, result) =>
      applyAgentHarnessResultClassification(harness, result, session.params),
    cleanup: async (_params) => {
      // V1 harnesses have no per-attempt cleanup hook. Global cleanup remains
      // on dispose(), which must not run after every attempt.
    },
    compact: harness.compact ? (params) => harness.compact!(params) : undefined,
    reset: harness.reset ? (params) => harness.reset!(params) : undefined,
    dispose: harness.dispose ? () => harness.dispose!() : undefined,
  };
}

function buildAgentHarnessContextEngineHostSupport(
  harness: AgentHarness,
): ContextEngineHostSupport {
  return {
    id: `agent-harness:${harness.id}`,
    label: `agent harness "${harness.id}"`,
    capabilities: harness.contextEngineHostCapabilities ?? [],
  };
}

function agentHarnessDiagnosticBase(
  harness: AgentHarnessV2,
  params: AgentHarnessAttemptParams,
  trace?: DiagnosticTraceContext,
) {
  const diagnosticTrace = trace ?? getActiveDiagnosticTraceContext();
  const channel = diagnosticChannel(params);
  return {
    runId: params.runId,
    sessionId: params.sessionId,
    provider: params.provider,
    model: params.modelId,
    harnessId: harness.id,
    ...(harness.pluginId ? { pluginId: harness.pluginId } : {}),
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(channel ? { channel } : {}),
    ...(diagnosticTrace ? { trace: freezeDiagnosticTraceContext(diagnosticTrace) } : {}),
  };
}

function agentHarnessRunOutcome(result: AgentHarnessAttemptResult): DiagnosticHarnessRunOutcome {
  if (result.promptError) {
    return "error";
  }
  if (result.externalAbort || result.aborted) {
    return "aborted";
  }
  if (result.timedOut || result.idleTimedOut || result.timedOutDuringCompaction) {
    return "timed_out";
  }
  return "completed";
}

function shouldEmitAgentRunDiagnostics(harness: AgentHarnessV2): boolean {
  return harness.id !== "openclaw";
}

function diagnosticChannel(params: AgentHarnessAttemptParams): string | undefined {
  return params.messageChannel ?? params.messageProvider;
}

function agentRunDiagnosticBase(params: AgentHarnessAttemptParams, trace: DiagnosticTraceContext) {
  const channel = diagnosticChannel(params);
  return {
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    provider: params.provider,
    model: params.modelId,
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(channel ? { channel } : {}),
    trace,
  };
}

function agentRunCompletion(result: AgentHarnessAttemptResult): AgentRunCompletion {
  if (result.promptErrorSource === "hook:before_agent_run") {
    return { outcome: "blocked", blockedBy: "before_agent_run" };
  }
  if (result.promptError) {
    return { outcome: "error", error: result.promptError };
  }
  if (
    result.externalAbort ||
    result.aborted ||
    result.timedOut ||
    result.idleTimedOut ||
    result.timedOutDuringCompaction
  ) {
    return { outcome: "aborted" };
  }
  return { outcome: "completed" };
}

function withFallbackDiagnosticTrace(
  result: AgentHarnessAttemptResult,
  trace: DiagnosticTraceContext | undefined,
): AgentHarnessAttemptResult {
  if (result.diagnosticTrace || !trace) {
    return result;
  }
  return {
    ...result,
    diagnosticTrace: freezeDiagnosticTraceContext(trace),
  };
}

function emitAgentHarnessRunStarted(
  harness: AgentHarnessV2,
  params: AgentHarnessAttemptParams,
  trace?: DiagnosticTraceContext,
): void {
  emitTrustedDiagnosticEvent({
    type: "harness.run.started",
    ...agentHarnessDiagnosticBase(harness, params, trace),
  });
}

function emitAgentHarnessRunCompleted(params: {
  harness: AgentHarnessV2;
  attemptParams: AgentHarnessAttemptParams;
  result: AgentHarnessAttemptResult;
  startedAt: number;
  trace?: DiagnosticTraceContext;
}): void {
  const { harness, attemptParams, result, startedAt, trace } = params;
  emitTrustedDiagnosticEvent({
    type: "harness.run.completed",
    ...agentHarnessDiagnosticBase(harness, attemptParams, trace ?? result.diagnosticTrace),
    durationMs: Date.now() - startedAt,
    outcome: agentHarnessRunOutcome(result),
    ...(result.agentHarnessResultClassification
      ? { resultClassification: result.agentHarnessResultClassification }
      : {}),
    ...(typeof result.yieldDetected === "boolean" ? { yieldDetected: result.yieldDetected } : {}),
    itemLifecycle: { ...result.itemLifecycle },
  });
}

function emitAgentHarnessRunError(params: {
  harness: AgentHarnessV2;
  attemptParams: AgentHarnessAttemptParams;
  startedAt: number;
  phase: AgentHarnessV2LifecyclePhase;
  error: unknown;
  cleanupFailed?: boolean;
  trace?: DiagnosticTraceContext;
}): void {
  const { harness, attemptParams, startedAt, phase, error, cleanupFailed, trace } = params;
  emitTrustedDiagnosticEvent({
    type: "harness.run.error",
    ...agentHarnessDiagnosticBase(harness, attemptParams, trace),
    durationMs: Date.now() - startedAt,
    phase,
    errorCategory: diagnosticErrorCategory(error),
    ...(cleanupFailed ? { cleanupFailed: true } : {}),
  });
}

export async function runAgentHarnessV2LifecycleAttempt(
  harness: AgentHarnessV2,
  params: AgentHarnessAttemptParams,
): Promise<AgentHarnessAttemptResult> {
  let prepared: AgentHarnessV2PreparedRun | undefined;
  let session: AgentHarnessV2Session | undefined;
  let rawResult: AgentHarnessAttemptResult | undefined;
  let result: AgentHarnessAttemptResult;
  let phase: AgentHarnessV2LifecyclePhase = "prepare";
  const startedAt = Date.now();
  const activeHarnessTrace = getActiveDiagnosticTraceContext();
  let agentRunTrace: DiagnosticTraceContext | undefined;
  let agentRunStartedAt = 0;
  let agentRunCompleted = false;
  const emitAgentRunCompleted = (completion: AgentRunCompletion): void => {
    if (!agentRunTrace || agentRunCompleted) {
      return;
    }
    agentRunCompleted = true;
    emitTrustedDiagnosticEvent({
      type: "run.completed",
      ...agentRunDiagnosticBase(params, agentRunTrace),
      durationMs: Date.now() - agentRunStartedAt,
      outcome: completion.outcome,
      ...(completion.blockedBy ? { blockedBy: completion.blockedBy } : {}),
      ...(completion.error && completion.outcome === "error"
        ? { errorCategory: diagnosticErrorCategory(completion.error) }
        : {}),
    });
  };

  emitAgentHarnessRunStarted(harness, params, activeHarnessTrace);
  try {
    phase = "prepare";
    prepared = await harness.prepare(params);
    phase = "start";
    session = await harness.start(prepared);
    const startedSession = session;
    if (shouldEmitAgentRunDiagnostics(harness) && activeHarnessTrace) {
      agentRunTrace = freezeDiagnosticTraceContext(
        createChildDiagnosticTraceContext(activeHarnessTrace),
      );
      agentRunStartedAt = Date.now();
      emitTrustedDiagnosticEvent({
        type: "run.started",
        ...agentRunDiagnosticBase(params, agentRunTrace),
      });
    }
    const sendAndResolve = async () => {
      phase = "send";
      rawResult = await harness.send(startedSession);
      phase = "resolve";
      return await harness.resolveOutcome(startedSession, rawResult);
    };
    result = agentRunTrace
      ? await runWithDiagnosticTraceContext(agentRunTrace, sendAndResolve)
      : await sendAndResolve();
    result = withFallbackDiagnosticTrace(result, activeHarnessTrace);
  } catch (error) {
    let cleanupFailed = false;
    try {
      await harness.cleanup({
        prepared,
        session,
        error,
        ...(rawResult === undefined ? {} : { result: rawResult }),
      });
    } catch (cleanupError) {
      cleanupFailed = true;
      // Preserve the user-visible harness failure. Cleanup errors after a
      // failed lifecycle stage must not mask the actionable runtime error.
      log.warn("agent harness cleanup failed after attempt failure", {
        harnessId: harness.id,
        provider: params.provider,
        modelId: params.modelId,
        error: formatErrorMessage(cleanupError),
        originalError: formatErrorMessage(error),
      });
    }
    emitAgentHarnessRunError({
      harness,
      attemptParams: params,
      startedAt,
      phase,
      error,
      cleanupFailed,
      trace: activeHarnessTrace,
    });
    emitAgentRunCompleted({ outcome: "error", error });
    throw error;
  }

  try {
    phase = "cleanup";
    await harness.cleanup({ prepared, session, result });
  } catch (error) {
    emitAgentHarnessRunError({
      harness,
      attemptParams: params,
      startedAt,
      phase,
      error,
      trace: activeHarnessTrace,
    });
    emitAgentRunCompleted({ outcome: "error", error });
    throw error;
  }
  emitAgentRunCompleted(agentRunCompletion(result));
  emitAgentHarnessRunCompleted({
    harness,
    attemptParams: params,
    result,
    startedAt,
    trace: activeHarnessTrace,
  });
  return result;
}
