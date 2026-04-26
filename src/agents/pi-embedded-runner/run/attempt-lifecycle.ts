import { emitTrustedDiagnosticEvent } from "../../../infra/diagnostic-events.js";
import {
  createChildDiagnosticTraceContext,
  createDiagnosticTraceContextFromActiveScope,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import { diagnosticErrorCategory } from "./attempt.model-diagnostic-events.js";
import type { EmbeddedRunAttemptParams } from "./types.js";

type RunLifecycleDiagnosticsParams = Pick<
  EmbeddedRunAttemptParams,
  "runId" | "provider" | "modelId" | "trigger" | "messageChannel" | "messageProvider"
> & {
  sessionKey?: string;
  sessionId?: string;
};

export type RunLifecycleDiagnosticOutcome = "completed" | "aborted" | "error";

export type RunLifecycleDiagnostics = {
  diagnosticTrace: DiagnosticTraceContext;
  runTrace: DiagnosticTraceContext;
  emitCompleted: (outcome: RunLifecycleDiagnosticOutcome, err?: unknown) => void;
};

function buildRunDiagnosticBase(
  params: RunLifecycleDiagnosticsParams,
  runTrace: DiagnosticTraceContext,
) {
  return {
    runId: params.runId,
    ...(params.sessionKey && { sessionKey: params.sessionKey }),
    ...(params.sessionId && { sessionId: params.sessionId }),
    provider: params.provider,
    model: params.modelId,
    trigger: params.trigger,
    ...((params.messageChannel ?? params.messageProvider)
      ? { channel: params.messageChannel ?? params.messageProvider }
      : {}),
    trace: runTrace,
  };
}

export function startRunLifecycleDiagnostics(
  params: RunLifecycleDiagnosticsParams,
): RunLifecycleDiagnostics {
  const diagnosticTrace = freezeDiagnosticTraceContext(
    createDiagnosticTraceContextFromActiveScope(),
  );
  const runTrace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(diagnosticTrace));
  const diagnosticRunBase = buildRunDiagnosticBase(params, runTrace);
  const diagnosticRunStartedAt = Date.now();
  let completed = false;

  emitTrustedDiagnosticEvent({
    type: "run.started",
    ...diagnosticRunBase,
  });

  return {
    diagnosticTrace,
    runTrace,
    emitCompleted: (outcome, err) => {
      if (completed) {
        return;
      }
      completed = true;
      emitTrustedDiagnosticEvent({
        type: "run.completed",
        ...diagnosticRunBase,
        durationMs: Date.now() - diagnosticRunStartedAt,
        outcome,
        ...(err ? { errorCategory: diagnosticErrorCategory(err) } : {}),
      });
    },
  };
}
