import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import { asNonNegativeFiniteNumber as numericValue } from "openclaw/plugin-sdk/number-runtime";
import type { DiagnosticEventPayload } from "../api.js";
import { seconds } from "./prometheus-format.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

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
        | "session.stalled"
        | "session.long_running"
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
    case "session.stalled":
    case "session.long_running": {
      // Repeated health observations are events, not a count of unique sessions.
      const labels = {
        active_work_kind: normalizeDiagnosticValue(evt.activeWorkKind, "none"),
        reason: normalizeDiagnosticValue(evt.reason, "none"),
        state: evt.state,
      };
      if (evt.type === "session.stalled") {
        store.counter(
          "openclaw_session_stalled_total",
          "Session stall observations by classification and active work kind.",
          { ...labels, classification: evt.classification },
        );
      } else {
        store.counter(
          "openclaw_session_long_running_total",
          "Long-running session observations, including permitted waits, by active work kind.",
          labels,
        );
      }
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
