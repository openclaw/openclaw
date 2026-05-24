import { globalMetrics } from "../kernel/metrics.js";

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

const PLAYBOOK_RUN_COUNTER_NAMES = new Set([
  "playbook.started",
  "playbook.completed",
  "playbook.failed",
]);

function playbookStatusFromCounterName(name: string): string | null {
  if (name.startsWith("playbook.started")) {
    return "started";
  }
  if (name.startsWith("playbook.completed")) {
    return "completed";
  }
  if (name.startsWith("playbook.failed")) {
    return "failed";
  }
  return null;
}

function extractPlaybookIdFromCounterKey(key: string): string {
  const match = key.match(/playbook_id="([^"]+)"/);
  return match?.[1] ?? "unknown";
}

/** 从 globalMetrics 计数器提取 Playbook 运行维度（供 Prometheus 专用指标）。 */
export function playbookRunMetricsFromSnapshot(
  counters: Record<string, number>,
): Array<{ status: string; playbookId: string; value: number }> {
  const rows: Array<{ status: string; playbookId: string; value: number }> = [];
  for (const [key, value] of Object.entries(counters)) {
    const baseName = key.split("{")[0] ?? key;
    if (!PLAYBOOK_RUN_COUNTER_NAMES.has(baseName)) {
      continue;
    }
    const status = playbookStatusFromCounterName(baseName);
    if (!status) {
      continue;
    }
    rows.push({
      status,
      playbookId: extractPlaybookIdFromCounterKey(key),
      value,
    });
  }
  return rows;
}

export function prometheusMetricsText(robotName: string): string {
  const uptime = runtimeUptimeSeconds();
  const snap = globalMetrics.snapshot();
  const playbookRuns = playbookRunMetricsFromSnapshot(snap.counters);

  const lines: string[] = [
    "# HELP claworks_uptime_seconds Process uptime in seconds",
    "# TYPE claworks_uptime_seconds gauge",
    `claworks_uptime_seconds{robot="${robotName}"} ${uptime}`,
    "# HELP claworks_decision_log_entries Number of entries in the in-memory decision log",
    "# TYPE claworks_decision_log_entries gauge",
    `claworks_decision_log_entries ${decisionLog.length}`,
    "# HELP claworks_observation_events Number of entries in the in-memory observation event log",
    "# TYPE claworks_observation_events gauge",
    `claworks_observation_events ${observationEvents.length}`,
  ];

  if (playbookRuns.length > 0) {
    lines.push(
      "# HELP claworks_playbook_runs_total Playbook run counters by status and playbook_id",
      "# TYPE claworks_playbook_runs_total counter",
    );
    for (const row of playbookRuns) {
      const safeId = row.playbookId.replace(/"/g, "'");
      lines.push(
        `claworks_playbook_runs_total{status="${row.status}",playbook_id="${safeId}"} ${row.value}`,
      );
    }
  }

  // Emit all globalMetrics counters as Prometheus counters
  const counterEntries = Object.entries(snap.counters);
  if (counterEntries.length > 0) {
    lines.push(
      "# HELP claworks_counter_total Runtime event / capability / playbook counters",
      "# TYPE claworks_counter_total counter",
    );
    for (const [key, value] of counterEntries) {
      // key may already include labels like `playbook.run{playbook_id="x"}`
      const safeKey = key.replace(/[^a-zA-Z0-9_{}"=,. ]/g, "_");
      lines.push(`claworks_counter_total{name="${safeKey}"} ${value}`);
    }
  }

  // Emit histogram p50/p95/p99 as gauges
  const histEntries = Object.entries(snap.histograms);
  if (histEntries.length > 0) {
    lines.push(
      "# HELP claworks_duration_p95_ms p95 duration in milliseconds",
      "# TYPE claworks_duration_p95_ms gauge",
    );
    for (const [key, stats] of histEntries) {
      const safeKey = key.replace(/[^a-zA-Z0-9_{}"=,. ]/g, "_");
      lines.push(`claworks_duration_p95_ms{name="${safeKey}"} ${stats.p95}`);
    }
  }

  lines.push("");
  return lines.join("\n");
}
