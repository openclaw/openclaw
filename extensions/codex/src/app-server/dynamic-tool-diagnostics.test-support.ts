import {
  waitForDiagnosticEventsDrained,
  type DiagnosticEventPayload,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { startDynamicToolDiagnosticExecution } from "./dynamic-tool-diagnostics.js";

export function emitDynamicToolStartedDiagnostic(
  params: Parameters<typeof startDynamicToolDiagnosticExecution>[0],
): void {
  startDynamicToolDiagnosticExecution(params, () => undefined);
}

export function flushDiagnosticEvents() {
  return waitForDiagnosticEventsDrained();
}

export function activeDiagnosticToolKeys(events: DiagnosticEventPayload[]): Set<string> {
  const active = new Set<string>();
  for (const event of events) {
    if (event.type === "tool.execution.started") {
      active.add(
        `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${event.toolCallId ?? event.toolName}`,
      );
    } else if (
      event.type === "tool.execution.completed" ||
      event.type === "tool.execution.error" ||
      event.type === "tool.execution.blocked"
    ) {
      active.delete(
        `${event.runId ?? event.sessionId ?? event.sessionKey ?? "unknown"}:${event.toolCallId ?? event.toolName}`,
      );
    }
  }
  return active;
}
