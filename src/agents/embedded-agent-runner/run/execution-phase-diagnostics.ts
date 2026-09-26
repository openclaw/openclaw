import {
  areDiagnosticsEnabledForProcess,
  emitDiagnosticEvent,
} from "../../../infra/diagnostic-events.js";
import type { RunEmbeddedAgentParams } from "./params.js";

type ExecutionPhaseCallback = NonNullable<RunEmbeddedAgentParams["onExecutionPhase"]>;
type SessionIdChangedCallback = NonNullable<RunEmbeddedAgentParams["onSessionIdChanged"]>;

type ExecutionPhaseParams = Pick<
  RunEmbeddedAgentParams,
  "onExecutionPhase" | "onSessionIdChanged" | "runId" | "sessionId" | "sessionKey"
>;

/** Tracks session rotation so diagnostics keep the current identity after compaction. */
export function withExecutionPhaseDiagnostics<T extends ExecutionPhaseParams>(
  params: T,
): T & { onExecutionPhase: ExecutionPhaseCallback; onSessionIdChanged: SessionIdChangedCallback } {
  const forwardPhase = params.onExecutionPhase;
  const forwardSessionIdChanged = params.onSessionIdChanged;
  let currentSessionId = params.sessionId;
  const onSessionIdChanged: SessionIdChangedCallback = (sessionId) => {
    currentSessionId = sessionId;
    forwardSessionIdChanged?.(sessionId);
  };
  const onExecutionPhase: ExecutionPhaseCallback = (info) => {
    if (areDiagnosticsEnabledForProcess()) {
      emitDiagnosticEvent({
        type: "run.execution_phase",
        runId: params.runId,
        sessionId: currentSessionId,
        sessionKey: params.sessionKey,
        ...info,
      });
    }
    forwardPhase?.(info);
  };
  return { ...params, onExecutionPhase, onSessionIdChanged };
}
