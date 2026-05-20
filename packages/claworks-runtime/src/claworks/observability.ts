export type DecisionLogEntry = {
  id: string;
  at: string;
  playbookId?: string;
  runId?: string;
  stepId?: string;
  kind: string;
  summary: string;
  detail?: Record<string, unknown>;
};

export type ObservationEvent = {
  id: string;
  at: string;
  source: string;
  type: string;
  payload: Record<string, unknown>;
};

const decisionLog: DecisionLogEntry[] = [];
const observationEvents: ObservationEvent[] = [];
const MAX = 500;

let startedAt = Date.now();

export function markRuntimeStarted(): void {
  startedAt = Date.now();
}

export function runtimeUptimeSeconds(): number {
  return Math.floor((Date.now() - startedAt) / 1000);
}

export function appendDecisionLog(entry: Omit<DecisionLogEntry, "id" | "at">): void {
  decisionLog.unshift({
    id: `dec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...entry,
  });
  if (decisionLog.length > MAX) {
    decisionLog.length = MAX;
  }
}

export function listDecisionLog(limit = 50): DecisionLogEntry[] {
  return decisionLog.slice(0, limit);
}

export function appendObservationEvent(
  source: string,
  type: string,
  payload: Record<string, unknown>,
): void {
  observationEvents.unshift({
    id: `obs-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    source,
    type,
    payload,
  });
  if (observationEvents.length > MAX) {
    observationEvents.length = MAX;
  }
}

export function listObservationEvents(limit = 50): ObservationEvent[] {
  return observationEvents.slice(0, limit);
}

export function prometheusMetricsText(robotName: string): string {
  const uptime = runtimeUptimeSeconds();
  return [
    "# HELP claworks_uptime_seconds Process uptime",
    "# TYPE claworks_uptime_seconds gauge",
    `claworks_uptime_seconds{robot="${robotName}"} ${uptime}`,
    "# HELP claworks_decision_log_entries Decision log size",
    "# TYPE claworks_decision_log_entries gauge",
    `claworks_decision_log_entries ${decisionLog.length}`,
    "",
  ].join("\n");
}
