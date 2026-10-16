import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import { asNonNegativeFiniteNumber as numericValue } from "openclaw/plugin-sdk/number-runtime";
import type { DiagnosticEventPayload, OpenClawPluginServiceContext } from "../api.js";
import { seconds } from "./prometheus-format.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

type InternalDiagnostics = NonNullable<OpenClawPluginServiceContext["internalDiagnostics"]>;
type GatewayWorkMetricsListener = Parameters<
  NonNullable<InternalDiagnostics["onGatewayWorkMetrics"]>
>[0];

export function createGatewayWorkMetricsRecorder(
  store: PrometheusMetricStore,
): GatewayWorkMetricsListener {
  return (snapshot) => {
    if (!snapshot) {
      store.clearGauges("openclaw_sessions_active");
      store.clearGauges("openclaw_gateway_active_work");
      return;
    }
    for (const state of ["running", "queued"] as const) {
      store.gauge(
        "openclaw_sessions_active",
        "Current active sessions in the Gateway session roster by run state.",
        { state },
        snapshot.sessions[state],
      );
    }
    for (const kind of ["agentRuns", "chatRuns", "queuedTurns"] as const) {
      store.gauge(
        "openclaw_gateway_active_work",
        "Current Gateway work by owner; categories may overlap.",
        { kind },
        snapshot.work[kind],
      );
    }
  };
}

export function recordSessionDiagnosticEvent(
  store: PrometheusMetricStore,
  evt: Extract<
    DiagnosticEventPayload,
    {
      type:
        | "session.recovery.requested"
        | "session.recovery.completed"
        | "session.state"
        | "session.stuck"
        | "session.turn.created";
    }
  >,
): void {
  switch (evt.type) {
    case "session.recovery.requested":
    case "session.recovery.completed": {
      const labels = {
        action:
          evt.type === "session.recovery.completed"
            ? normalizeDiagnosticValue(evt.action, "unknown")
            : evt.allowActiveAbort
              ? "abort"
              : "recover",
        active_work_kind: normalizeDiagnosticValue(evt.activeWorkKind, "none"),
        state: evt.state,
        status: evt.type === "session.recovery.completed" ? evt.status : "requested",
      };
      store.counter(
        "openclaw_session_recovery_total",
        "Session recovery observations by status and action.",
        labels,
      );
      store.histogram(
        "openclaw_session_recovery_age_seconds",
        "Age of sessions selected for recovery in seconds.",
        labels,
        seconds(evt.ageMs),
      );
      return;
    }
    case "session.state":
      store.counter(
        "openclaw_session_state_total",
        "Cumulative session state observations since exporter start; not current sessions.",
        {
          reason: normalizeDiagnosticValue(evt.reason, "none"),
          state: evt.state,
        },
      );
      if (evt.queueDepth !== undefined) {
        store.gauge(
          "openclaw_session_queue_depth",
          "Latest observed session queue depth.",
          {
            state: evt.state,
          },
          numericValue(evt.queueDepth),
        );
      }
      return;
    case "session.stuck": {
      const labels = {
        reason: normalizeDiagnosticValue(evt.reason, "none"),
        state: evt.state,
      };
      store.counter(
        "openclaw_session_stuck_total",
        "Stale session bookkeeping observations with no active work.",
        labels,
      );
      store.histogram(
        "openclaw_session_stuck_age_seconds",
        "Age of stale session bookkeeping observations in seconds.",
        labels,
        seconds(evt.ageMs),
      );
      return;
    }
    case "session.turn.created":
      store.counter("openclaw_session_turn_created_total", "Agent session turns created.", {
        agent: normalizeDiagnosticValue(evt.agentId),
        channel: normalizeDiagnosticValue(evt.channel),
        trigger: evt.trigger,
      });
  }
}
