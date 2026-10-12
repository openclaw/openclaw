import { assertContextEngineHostSupport } from "../../context-engine/host-compat.js";
import {
  diagnosticErrorCategory,
  diagnosticErrorMessage,
} from "../../infra/diagnostic-error-metadata.js";
import {
  emitTrustedDiagnosticEvent,
  emitTrustedDiagnosticEventWithPrivateData,
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
import {
  normalizeAgentRunAttemptTerminal,
  projectAgentRunAttemptTerminal,
} from "../agent-run-terminal-outcome.js";
import type { EmbeddedRunAttemptResult } from "../embedded-agent-runner/run/types.js";
import { copyCoreTtsAttemptResultProvenance } from "../tools/tts-tool-result-provenance.js";
import { subscribeAgentCommentaryDiagnostics } from "./commentary-diagnostics.js";
import { recordAgentHarnessPreflightOwner } from "./errors.js";
import { applyAgentHarnessResultClassification } from "./result-classification.js";
import { EmptySettledTurnFinalizationError } from "./settled-turn-finalization-outcome.js";
import { assertSettledTurnFinalizationResult } from "./settled-turn-finalization-result.js";
import type {
  AgentHarness,
  AgentHarnessAttemptParams,
  AgentHarnessAttemptParamsV2,
  AgentHarnessAttemptResult,
  AgentHarnessSettledTurnFinalizationAttemptParams,
  AgentHarnessSettledTurnFinalizationResult,
} from "./types.js";

type AgentHarnessLifecycleFinalizationOutcome =
  | { outcome: "answered"; result: AgentHarnessSettledTurnFinalizationResult }
  | { outcome: "empty"; result: AgentHarnessSettledTurnFinalizationResult };

type AgentHarnessLifecyclePhase = DiagnosticHarnessRunErrorEvent["phase"];
type AgentRunCompletion = {
  outcome: "completed" | "aborted" | "blocked" | "error";
  blockedBy?: string;
  error?: unknown;
};

function assertAgentHarnessContextEngineSupport(
  harness: AgentHarness,
  params: AgentHarnessAttemptParamsV2,
): void {
  if (!params.contextEngine || params.contextEngine.info.id === "legacy") {
    return;
  }
  assertContextEngineHostSupport({
    contextEngine: params.contextEngine,
    operation: "agent-run",
    host: {
      id: `agent-harness:${harness.id}`,
      label: `agent harness "${harness.id}"`,
      capabilities: harness.contextEngineHostCapabilities ?? [],
    },
  });
}

function agentHarnessDiagnosticBase(
  harness: AgentHarness,
  params: AgentHarnessAttemptParams,
  trace?: DiagnosticTraceContext,
) {
  const diagnosticTrace = trace ?? getActiveDiagnosticTraceContext();
  const channel = params.messageChannel ?? params.messageProvider;
  return {
    runId: params.runId,
    sessionId: params.sessionId,
    ...(params.agentId ? { agentId: params.agentId } : {}),
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

function normalizeAgentHarnessAttemptResult(
  result: AgentHarnessAttemptResult,
): EmbeddedRunAttemptResult {
  const {
    aborted,
    externalAbort,
    idleTimedOut,
    promptError,
    promptErrorSource,
    timedOut,
    timedOutByRunBudget,
    timedOutDuringCompaction,
    timedOutDuringToolExecution,
    ...canonical
  } = result;
  // Legacy harnesses omit the field and report this attempt only through lastAssistant.
  // Explicit undefined is the current contract's no-response fact and must survive unchanged.
  const currentAttemptProvenance = Object.hasOwn(result, "currentAttemptAssistant")
    ? { currentAttemptAssistant: result.currentAttemptAssistant }
    : result.lastAssistant
      ? { currentAttemptAssistant: result.lastAssistant }
      : {};
  const canonicalWithAttemptProvenance = {
    ...canonical,
    ...currentAttemptProvenance,
  };
  if ("terminal" in canonicalWithAttemptProvenance) {
    return canonicalWithAttemptProvenance;
  }
  const terminal = normalizeAgentRunAttemptTerminal({
    aborted,
    externalAbort,
    idleTimedOut,
    promptError,
    promptErrorSource,
    timedOut,
    timedOutByRunBudget,
    timedOutDuringCompaction,
    timedOutDuringToolExecution,
  });
  return { ...canonicalWithAttemptProvenance, terminal };
}

function agentRunDiagnosticBase(params: AgentHarnessAttemptParams, trace: DiagnosticTraceContext) {
  const channel = params.messageChannel ?? params.messageProvider;
  return {
    runId: params.runId,
    ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
    ...(params.sessionId ? { sessionId: params.sessionId } : {}),
    ...(params.agentId ? { agentId: params.agentId } : {}),
    provider: params.provider,
    model: params.modelId,
    ...(params.trigger ? { trigger: params.trigger } : {}),
    ...(channel ? { channel } : {}),
    trace,
  };
}

function emitAgentRunCompleted(
  params: AgentHarnessAttemptParams,
  trace: DiagnosticTraceContext | undefined,
  startedAt: number,
  completion: AgentRunCompletion,
  classifyMissingError = false,
): void {
  if (!trace) {
    return;
  }
  const failed =
    completion.outcome === "error" && (completion.error != null || classifyMissingError);
  const errorMessage = failed ? diagnosticErrorMessage(completion.error) : undefined;
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "run.completed",
      ...agentRunDiagnosticBase(params, trace),
      durationMs: Date.now() - startedAt,
      outcome: completion.outcome,
      ...(completion.blockedBy ? { blockedBy: completion.blockedBy } : {}),
      ...(failed ? { errorCategory: diagnosticErrorCategory(completion.error) } : {}),
    },
    errorMessage ? { errorMessage } : undefined,
  );
}

function agentRunCompletion(result: EmbeddedRunAttemptResult): AgentRunCompletion {
  const terminal = projectAgentRunAttemptTerminal(result.terminal);
  if (terminal.timedOut || terminal.externalAbort || terminal.aborted) {
    return { outcome: "aborted" };
  }
  if (terminal.promptErrorSource === "hook:before_agent_run") {
    return { outcome: "blocked", blockedBy: "before_agent_run" };
  }
  if (terminal.promptErrorSource !== null) {
    return { outcome: "error", error: terminal.promptError };
  }
  return { outcome: "completed" };
}

function withFallbackDiagnosticTrace(
  result: EmbeddedRunAttemptResult,
  trace: DiagnosticTraceContext | undefined,
): EmbeddedRunAttemptResult {
  if (result.diagnosticTrace || !trace) {
    return result;
  }
  return copyCoreTtsAttemptResultProvenance(result, {
    ...result,
    diagnosticTrace: freezeDiagnosticTraceContext(trace),
  });
}

function emitAgentHarnessRunCompleted(params: {
  harness: AgentHarness;
  attemptParams: AgentHarnessAttemptParams;
  result: EmbeddedRunAttemptResult;
  startedAt: number;
  trace?: DiagnosticTraceContext;
}): void {
  const { harness, attemptParams, result, startedAt, trace } = params;
  const completion = agentRunCompletion(result);
  const terminal = projectAgentRunAttemptTerminal(result.terminal);
  const outcome: DiagnosticHarnessRunOutcome = terminal.timedOut
    ? "timed_out"
    : completion.outcome === "blocked"
      ? "error"
      : completion.outcome;
  // A classified (non-thrown) failure carries its error on result.terminal;
  // forward the message so the error span shows more than a bare category.
  const errorMessage =
    outcome === "error" ? diagnosticErrorMessage(terminal.promptError) : undefined;
  emitTrustedDiagnosticEventWithPrivateData(
    {
      type: "harness.run.completed",
      ...agentHarnessDiagnosticBase(harness, attemptParams, trace ?? result.diagnosticTrace),
      durationMs: Date.now() - startedAt,
      outcome,
      ...(result.agentHarnessResultClassification
        ? { resultClassification: result.agentHarnessResultClassification }
        : {}),
      ...(typeof result.yieldDetected === "boolean" ? { yieldDetected: result.yieldDetected } : {}),
      itemLifecycle: { ...result.itemLifecycle },
    },
    errorMessage ? { errorMessage } : undefined,
  );
}

function createAgentHarnessLifecycleDiagnostics(
  harness: AgentHarness,
  params: AgentHarnessAttemptParams,
  finalizing = false,
) {
  const startedAt = Date.now();
  const trace = getActiveDiagnosticTraceContext();
  const createRunTrace = () =>
    harness.id !== "openclaw" && trace
      ? freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(trace))
      : undefined;
  let agentRunTrace = finalizing ? createRunTrace() : undefined;
  let agentRunStartedAt = finalizing ? startedAt : 0;
  let phase: AgentHarnessLifecyclePhase = "prepare";
  emitTrustedDiagnosticEvent({
    type: "harness.run.started",
    ...agentHarnessDiagnosticBase(harness, params, trace),
  });
  const unsubscribe = subscribeAgentCommentaryDiagnostics(
    params.config,
    agentHarnessDiagnosticBase(harness, params, trace),
  );
  const complete = (completion: AgentRunCompletion, classifyMissingError = false) =>
    emitAgentRunCompleted(
      params,
      agentRunTrace,
      agentRunStartedAt,
      completion,
      classifyMissingError,
    );
  return {
    startedAt,
    trace,
    unsubscribe,
    complete,
    setPhase(value: AgentHarnessLifecyclePhase) {
      phase = value;
    },
    startAgentRun() {
      if (!finalizing) {
        agentRunTrace = createRunTrace();
        if (agentRunTrace) {
          agentRunStartedAt = Date.now();
        }
      }
      if (agentRunTrace) {
        emitTrustedDiagnosticEvent({
          type: "run.started",
          ...agentRunDiagnosticBase(params, agentRunTrace),
        });
      }
    },
    run<T>(execute: () => Promise<T>): Promise<T> {
      return agentRunTrace ? runWithDiagnosticTraceContext(agentRunTrace, execute) : execute();
    },
    fail(error: unknown) {
      if (!finalizing) {
        recordAgentHarnessPreflightOwner(error, harness.id);
      }
      const errorMessage = diagnosticErrorMessage(error);
      emitTrustedDiagnosticEventWithPrivateData(
        {
          type: "harness.run.error",
          ...agentHarnessDiagnosticBase(harness, params, trace),
          durationMs: Date.now() - startedAt,
          phase,
          errorCategory: diagnosticErrorCategory(error),
        },
        errorMessage ? { errorMessage } : undefined,
      );
      complete({ outcome: "error", error }, finalizing);
    },
  };
}

export async function runAgentHarnessLifecycleAttempt(
  harness: AgentHarness,
  params: AgentHarnessAttemptParamsV2,
  execute: (params: AgentHarnessAttemptParamsV2) => Promise<AgentHarnessAttemptResult> = (
    attemptParams,
  ) => harness.runAttempt(attemptParams),
): Promise<EmbeddedRunAttemptResult> {
  let result: EmbeddedRunAttemptResult;
  const diagnostics = createAgentHarnessLifecycleDiagnostics(harness, params);
  try {
    assertAgentHarnessContextEngineSupport(harness, params);
    diagnostics.startAgentRun();
    const runAndClassify = async () => {
      diagnostics.setPhase("send");
      const rawResult = await execute(params);
      diagnostics.setPhase("resolve");
      // Classification happens inside the diagnostic phase so failures identify
      // whether they came from send or result resolution.
      return copyCoreTtsAttemptResultProvenance(
        rawResult,
        normalizeAgentHarnessAttemptResult(
          applyAgentHarnessResultClassification(harness, rawResult, params),
        ),
      );
    };
    result = await diagnostics.run(runAndClassify);
    result = withFallbackDiagnosticTrace(result, diagnostics.trace);
  } catch (error) {
    diagnostics.fail(error);
    throw error;
  } finally {
    diagnostics.unsubscribe();
  }

  diagnostics.complete(agentRunCompletion(result));
  emitAgentHarnessRunCompleted({
    harness,
    attemptParams: params,
    result,
    startedAt: diagnostics.startedAt,
    trace: diagnostics.trace,
  });
  return result;
}

export async function runAgentHarnessLifecycleFinalization(
  harness: AgentHarness,
  params: AgentHarnessSettledTurnFinalizationAttemptParams<AgentHarnessAttemptParamsV2>,
  execute: () => Promise<AgentHarnessSettledTurnFinalizationResult>,
): Promise<AgentHarnessLifecycleFinalizationOutcome> {
  const diagnostics = createAgentHarnessLifecycleDiagnostics(harness, params, true);
  diagnostics.startAgentRun();
  try {
    const runAndValidate = async () => {
      diagnostics.setPhase("send");
      try {
        const rawResult = await execute();
        diagnostics.setPhase("resolve");
        return {
          outcome: "answered" as const,
          result: assertSettledTurnFinalizationResult(rawResult),
        };
      } catch (error) {
        if (error instanceof EmptySettledTurnFinalizationError) {
          return { outcome: "empty" as const, result: error.result };
        }
        throw error;
      }
    };
    const rawResult = await diagnostics.run(runAndValidate);
    const result = {
      ...rawResult,
      result:
        rawResult.result.diagnosticTrace || !diagnostics.trace
          ? rawResult.result
          : {
              ...rawResult.result,
              diagnosticTrace: freezeDiagnosticTraceContext(diagnostics.trace),
            },
    };
    diagnostics.complete({ outcome: "completed" });
    emitTrustedDiagnosticEvent({
      type: "harness.run.completed",
      ...agentHarnessDiagnosticBase(
        harness,
        params,
        result.result.diagnosticTrace ?? diagnostics.trace,
      ),
      durationMs: Date.now() - diagnostics.startedAt,
      outcome: "completed",
      itemLifecycle: { startedCount: 0, completedCount: 0, activeCount: 0 },
    });
    return result;
  } catch (error) {
    diagnostics.fail(error);
    throw error;
  } finally {
    diagnostics.unsubscribe();
  }
}
