import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { DiagnosticEventMetadata, DiagnosticEventPayload } from "../api.js";
import { seconds } from "./prometheus-format.js";
import type { PrometheusMetricStore } from "./prometheus-metric-store.js";

// Preserve existing le series while narrowing RPC quantile interpolation through 30 seconds.
const RPC_DURATION_BUCKETS_SECONDS = [
  0.005, 0.01, 0.0125, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05, 0.06, 0.08, 0.1, 0.125, 0.15, 0.2,
  0.25, 0.3, 0.4, 0.5, 0.6, 0.8, 1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 12.5, 15, 20, 25, 30, 60,
  120, 300, 600,
];

const RESPONSE_BYTE_BUCKETS = Array.from({ length: 17 }, (_, index) => 1024 * 2 ** index);
const MAIN_THREAD_STALL_BUCKETS_SECONDS = [0.25, 0.5, 1, 2.5, 5, 10];
const HEAP_DELTA_BYTE_BUCKETS = [
  ...RESPONSE_BYTE_BUCKETS.toReversed().map((bytes) => -bytes),
  0,
  ...RESPONSE_BYTE_BUCKETS,
];

const CATALOG_LIST_METHOD = "sessions.catalog.list";
const CATALOG_LIST_PHASE_PREFIX = `${CATALOG_LIST_METHOD}.`;
const CATALOG_LIST_PHASES = new Set([
  "projection_initial",
  "planning",
  "provider",
  "coalesced",
  "projection_final",
  "delivery",
]);
const CHAT_SEND_PHASE =
  /^chat\.send\.(authority|admission|preparation|attachments|replyContext|authoring|persist|runAdmission|replyInitialization|snapshot|worktree|effects|response|dispatch)$/;

export function recordOperationTimingEvent(
  store: PrometheusMetricStore,
  evt: Extract<
    DiagnosticEventPayload,
    {
      type:
        | "gateway.rpc"
        | "sessions.list.baseline.retired"
        | "diagnostic.phase.completed"
        | "gateway.http.cancelled"
        | "secret.egress"
        | "tool.catalog"
        | "diagnostic.gc"
        | "gateway.event_loop.sample"
        | "gateway.main_thread.stall";
    }
  >,
  metadata: DiagnosticEventMetadata,
): void {
  switch (evt.type) {
    case "sessions.list.baseline.retired":
      if (metadata.trusted) {
        store.counter(
          "openclaw_sessions_list_baseline_retirements_total",
          "Session list baseline retirement events by cause, not rows or views retired.",
          { cause: evt.cause },
        );
      }
      return;
    case "secret.egress":
      store.counter(
        "openclaw_secret_egress_requests_total",
        "Secret egress proxy requests by outcome and credential substitution.",
        { outcome: evt.outcome, substituted: String(evt.substituted) },
      );
      return;
    case "tool.catalog": {
      const labels = { source: evt.source, mode: evt.mode };
      store.counter("openclaw_tool_catalog_total", "Tool catalogs prepared.", labels);
      store.counter(
        "openclaw_tool_catalog_tools_total",
        "Tools cataloged during preparation.",
        labels,
        evt.toolCount,
      );
      return;
    }
    case "gateway.http.cancelled":
      store.counter(
        "openclaw_gateway_http_cancelled_total",
        "Gateway HTTP requests cancelled before completion.",
        { source: evt.source },
      );
      return;
    case "diagnostic.gc":
      store.histogram(
        "openclaw_gc_duration_seconds",
        "Elapsed garbage collection duration in seconds by collection kind, callback flags, and isolate role.",
        {
          kind: evt.kind ?? "unknown",
          reason: evt.reason ?? "other",
          thread: evt.thread ?? "main",
          ...(evt.workerSlot === undefined ? {} : { slot: String(evt.workerSlot) }),
        },
        seconds(evt.durationMs),
      );
      return;
    case "gateway.main_thread.stall":
      for (const stall of evt.stalls) {
        store.histogram(
          "openclaw_gateway_main_thread_stall_seconds",
          "Elapsed main-thread tasks lasting at least 250 milliseconds, by work scope.",
          { task: normalizeDiagnosticValue(stall.task) },
          seconds(stall.durationMs),
          MAIN_THREAD_STALL_BUCKETS_SECONDS,
        );
      }
      store.counter(
        "openclaw_gateway_main_thread_stalls_dropped_total",
        "Main-thread stall records dropped because the attribution buffer was full.",
        {},
        evt.dropped,
      );
      return;
    case "gateway.event_loop.sample":
      store.histogram(
        "openclaw_gateway_event_loop_delay_max_seconds",
        "Maximum event-loop delay per completed Gateway observation window in seconds.",
        {},
        seconds(evt.delayMaxMs),
      );
      store.counter(
        "openclaw_gateway_event_loop_observed_seconds_total",
        "Elapsed seconds covered by completed Gateway event-loop observation windows.",
        {},
        evt.intervalMs / 1000,
      );
      return;
    case "diagnostic.phase.completed": {
      if (!metadata.trusted) {
        return;
      }
      if (evt.name === "worktree.preparation") {
        recordWorktreePreparation(store, evt);
        return;
      }
      const sendPhase = CHAT_SEND_PHASE.exec(evt.name)?.[1];
      if (sendPhase) {
        const stage = evt.details?.stage;
        if (stage === "request" || stage === "startup" || stage === "steer" || stage === "queued") {
          store.histogram(
            "openclaw_chat_send_phase_seconds",
            "Elapsed chat.send owner phases before acknowledgement, during startup, or awaiting steering and queued follow-up delivery.",
            { phase: sendPhase, stage },
            seconds(evt.durationMs),
          );
        }
        return;
      }
      if (!evt.name.startsWith(CATALOG_LIST_PHASE_PREFIX)) {
        return;
      }
      const phase = evt.name.slice(CATALOG_LIST_PHASE_PREFIX.length);
      const duration = seconds(evt.durationMs);
      if (!CATALOG_LIST_PHASES.has(phase) || duration === undefined) {
        return;
      }
      const labels = { method: CATALOG_LIST_METHOD, phase };
      store.histogram(
        "openclaw_gateway_rpc_stage_seconds",
        "Elapsed time for completed Gateway RPC owner stages.",
        labels,
        duration,
      );
      const cpu = evt.details?.threadCpuMs;
      if ((phase === "planning" || phase === "delivery") && typeof cpu === "number") {
        store.histogram(
          "openclaw_gateway_rpc_stage_thread_cpu_seconds",
          "Current-thread CPU for synchronous Gateway RPC owner stages.",
          labels,
          seconds(cpu),
        );
      }
      return;
    }
    case "gateway.rpc": {
      const labels = { method: evt.method };
      if (evt.phase === "received") {
        store.counter(
          "openclaw_gateway_rpc_requests_total",
          "Authenticated Gateway WebSocket requests received.",
          labels,
        );
        // One extra sample per observed kind/method, without multiplying histogram buckets.
        store.counter(
          "openclaw_gateway_rpc_client_requests_total",
          "Gateway RPC requests by bounded handshake client kind.",
          { method: evt.method, client_kind: evt.clientKind ?? "other" },
        );
        if (evt.method === "models.list" && evt.modelsList) {
          const catalog = evt.modelsList;
          store.counter(
            "openclaw_models_list_requests_total",
            "Model catalog requests by client kind and bounded request shape.",
            {
              client_kind: catalog.clientKind,
              source: catalog.source,
              view: catalog.view,
              scope: catalog.scope,
              refresh: String(catalog.refresh),
              prepared_only: String(catalog.preparedOnly),
            },
          );
        }
        if (evt.method === "sessions.list" && evt.sessionsList) {
          const sessions = evt.sessionsList;
          store.counter(
            "openclaw_sessions_list_requests_total",
            "Session list requests by client kind and bounded request shape.",
            {
              client_kind: sessions.clientKind,
              source: sessions.source,
              caller_source: sessions.callerSource,
              row_mode: sessions.rowMode,
              filter: sessions.filter,
            },
          );
        }
        if (evt.method === "cron.list" && evt.cronList) {
          const cron = evt.cronList;
          store.counter(
            "openclaw_cron_list_requests_total",
            "Cron list requests by client kind and bounded request shape.",
            {
              client_kind: cron.clientKind,
              source: cron.source,
              scope: cron.scope,
              compact: String(cron.compact),
              page: cron.page,
            },
          );
        }
        return;
      }
      if (evt.phase === "response" && (evt.outcome === "ok" || evt.outcome === "error")) {
        if (
          evt.outcome === "ok" &&
          evt.firstResponse !== false &&
          evt.sessionsList?.baseMissReason
        ) {
          store.counter(
            "openclaw_sessions_list_base_misses_total",
            "Successful full sidebar responses with a supplied base, by miss reason.",
            { reason: evt.sessionsList.baseMissReason },
          );
        }
        store.histogram(
          "openclaw_gateway_rpc_response_bytes",
          "Encoded Gateway RPC response frame size in bytes, including later frames.",
          labels,
          evt.responseBytes,
          RESPONSE_BYTE_BUCKETS,
        );
        if (evt.responseBytes !== undefined && evt.sessionsList) {
          const sessions = evt.sessionsList;
          store.counter(
            "openclaw_sessions_list_response_bytes_total",
            "Encoded successful session list response bytes by request shape and row outcome.",
            {
              client_kind: sessions.clientKind,
              source: sessions.source,
              caller_source: sessions.callerSource,
              row_mode: sessions.rowMode,
              filter: sessions.filter,
              rows_outcome: sessions.rowsOutcome,
            },
            evt.responseBytes,
          );
        }
        if (evt.chatHistory) {
          const history = evt.chatHistory;
          const historyLabels = {
            client_kind: history.clientKind,
            source: history.source,
            shape: history.shape,
            limit_bucket: history.limitBucket,
            outcome: history.outcome,
          };
          if (evt.firstResponse !== false) {
            store.counter(
              "openclaw_chat_history_requests_total",
              "Successful chat history requests by request shape and response outcome.",
              historyLabels,
            );
          }
          if (evt.responseBytes !== undefined) {
            store.counter(
              "openclaw_chat_history_response_bytes_total",
              "Encoded successful chat history response bytes by request shape and response outcome.",
              historyLabels,
              evt.responseBytes,
            );
          }
        }
        if (evt.firstResponse === false) {
          return;
        }
      }
      store.counter(
        "openclaw_gateway_rpc_outcomes_total",
        "Gateway RPC observations by phase and outcome.",
        { phase: evt.phase, outcome: evt.outcome },
      );
      if (evt.phase === "response" && (evt.outcome === "ok" || evt.outcome === "error")) {
        store.histogram(
          "openclaw_gateway_rpc_first_response_seconds",
          "Elapsed time until the first Gateway RPC response is sent.",
          labels,
          seconds(evt.durationMs),
          RPC_DURATION_BUCKETS_SECONDS,
        );
      } else if (evt.phase === "handler") {
        if (evt.heapDeltaBytes !== undefined) {
          store.counter(
            "openclaw_gateway_rpc_handler_heap_delta_exclusive_total",
            "Gateway RPC handlers with an exclusive main-thread heap-change sample.",
            labels,
          );
        }
        store.histogram(
          "openclaw_gateway_rpc_handler_heap_delta_bytes",
          "Exclusive RPC handler heap change; background work and GC can affect signed samples.",
          labels,
          evt.heapDeltaBytes,
          HEAP_DELTA_BYTE_BUCKETS,
        );
        store.histogram(
          "openclaw_gateway_rpc_handler_seconds",
          "Gateway RPC handler duration until return or throw.",
          labels,
          seconds(evt.durationMs),
          RPC_DURATION_BUCKETS_SECONDS,
        );
        store.histogram(
          "openclaw_gateway_rpc_admission_seconds",
          "Elapsed time from Gateway RPC receipt until handler invocation.",
          labels,
          seconds(evt.admissionMs),
          RPC_DURATION_BUCKETS_SECONDS,
        );
      } else if (evt.phase === "dispatch") {
        store.histogram(
          "openclaw_gateway_rpc_queue_wait_seconds",
          "Gateway operator request start queue wait.",
          labels,
          seconds(evt.queueWaitMs),
          RPC_DURATION_BUCKETS_SECONDS,
        );
      }
    }
  }
}

function recordWorktreePreparation(
  store: PrometheusMetricStore,
  evt: Extract<DiagnosticEventPayload, { type: "diagnostic.phase.completed" }>,
) {
  const { kind, template, outcome } = evt.details ?? {};
  if (
    (kind !== "managed" && kind !== "sandbox") ||
    !["warm", "cold", "unavailable", "reused"].includes(String(template)) ||
    (outcome !== "returned" && outcome !== "threw")
  ) {
    return;
  }
  for (const phase of [
    "total",
    "allocate",
    "checkout",
    "setup",
    "templatePrepare",
    "templateApply",
    "snapshot",
    "synchronizeCanonical",
    "synchronizeProjection",
    "containerStart",
    "workspaceLayout",
  ]) {
    const elapsed = phase === "total" ? evt.durationMs : evt.details?.[phase];
    store.histogram(
      "openclaw_worktree_preparation_seconds",
      "Elapsed managed worktree preparation time; nested phases are inclusive.",
      { kind, template: String(template), outcome, phase },
      typeof elapsed === "number" ? seconds(elapsed) : undefined,
    );
  }
}
