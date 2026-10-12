import { emitDiagnosticEventWithTrustedTraceContext } from "../infra/diagnostic-events.js";
import type { ExecProcessOutcome } from "./bash-tools.exec-types.js";

export function emitExecProcessCompleted(params: {
  command: string;
  mode: "child" | "pty";
  outcome: ExecProcessOutcome;
  sessionKey?: string;
  target: "host" | "sandbox";
}): void {
  const signal = params.outcome.exitSignal;
  const exitSignal = signal === null ? undefined : String(signal);
  // Payload stays untrusted, but the ambient trace context is the OpenClaw run
  // scope, so exporters may use it to nest the exec span under its run.
  emitDiagnosticEventWithTrustedTraceContext({
    type: "exec.process.completed",
    target: params.target,
    mode: params.mode,
    outcome: params.outcome.status,
    durationMs: params.outcome.durationMs,
    commandLength: params.command.length,
    ...(params.sessionKey?.trim() ? { sessionKey: params.sessionKey.trim() } : {}),
    ...(typeof params.outcome.exitCode === "number" ? { exitCode: params.outcome.exitCode } : {}),
    ...(exitSignal ? { exitSignal } : {}),
    ...(params.outcome.status === "failed"
      ? {
          timedOut: params.outcome.timedOut,
          failureKind: params.outcome.failureKind,
        }
      : {}),
  });
}
