import type { IncomingMessage, ServerResponse } from "node:http";
import {
  isDiagnosticsEnabled,
  normalizeDiagnosticValue,
  normalizeDiagnosticLane,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { asNonNegativeFiniteNumber as numericValue } from "openclaw/plugin-sdk/number-runtime";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  OpenClawPluginHttpRouteHandler,
  OpenClawPluginService,
  OpenClawPluginServiceContext,
} from "../api.js";
import { isInternalDiagnosticEventMetadata, redactSensitiveText } from "../api.js";
import {
  escapeHelp,
  formatLabels,
  formatPrometheusNumber,
  seconds,
  type LabelSet,
} from "./prometheus-format.js";
import {
  AGENT_DURATION_BUCKETS_SECONDS,
  createPrometheusMetricStore,
  type PrometheusMetricStore,
} from "./prometheus-metric-store.js";
import { recordChildProcessSpawn } from "./service-child-process.js";
import { recordMemorySample } from "./service-memory.js";
import { recordModelUsage } from "./service-model-usage.js";
import { recordOperationTimingEvent } from "./service-operation-timing.js";
import {
  createGatewayWorkMetricsRecorder,
  recordSessionDiagnosticEvent,
} from "./service-sessions.js";
import { recordWorkerRequest } from "./service-worker.js";

const BYTE_BUCKETS = [
  1024, 4096, 16384, 65536, 262144, 1048576, 4194304, 16777216, 67108864, 268435456, 1073741824,
  4294967296, 17179869184,
];
const RATIO_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 0.75, 1, 2, 4, 8, 16];

function safeErrorMessage(err: unknown): string {
  const message = err instanceof Error ? (err.message ?? err.name) : String(err);
  return truncateUtf16Safe(
    redactSensitiveText(message)
      .replaceAll("\u0000", " ")
      .replace(/[\r\n\t\u2028\u2029]/gu, " "),
    500,
  );
}

function renderPrometheusMetrics(store: PrometheusMetricStore): string {
  const snapshot = store.snapshot();
  const lines: string[] = [];
  const emitted = new Set<string>();

  const emitHeader = (name: string, type: "counter" | "gauge" | "histogram", help: string) => {
    if (emitted.has(name)) {
      return;
    }
    emitted.add(name);
    lines.push(`# HELP ${name} ${escapeHelp(help)}`);
    lines.push(`# TYPE ${name} ${type}`);
  };

  for (const [type, entries] of [
    ["counter", snapshot.counters],
    ["gauge", snapshot.gauges],
  ] as const) {
    entries.sort(([left], [right]) => left.localeCompare(right));
    for (const [key, sample] of entries) {
      const name = key.split("|", 1)[0] ?? "";
      emitHeader(name, type, sample.help);
      lines.push(`${name}${formatLabels(sample.labels)} ${formatPrometheusNumber(sample.value)}`);
    }
  }

  snapshot.histograms.sort(([left], [right]) => left.localeCompare(right));
  for (const [key, sample] of snapshot.histograms) {
    const name = key.split("|", 1)[0] ?? "";
    emitHeader(name, "histogram", sample.help);
    for (let index = 0; index < sample.buckets.length; index += 1) {
      lines.push(
        `${sample.bucketPrefixes[index]}${formatPrometheusNumber(sample.counts[index] ?? 0)}`,
      );
    }
    lines.push(
      `${sample.bucketPrefixes[sample.buckets.length]}${formatPrometheusNumber(sample.count)}`,
    );
    lines.push(`${name}_sum${sample.labels} ${formatPrometheusNumber(sample.sum)}`);
    lines.push(`${name}_count${sample.labels} ${formatPrometheusNumber(sample.count)}`);
  }

  lines.push("");
  return lines.join("\n");
}

function webhookLabels(
  evt: Extract<
    DiagnosticEventPayload,
    { type: "webhook.received" | "webhook.processed" | "webhook.error" }
  >,
): LabelSet {
  return {
    channel: normalizeDiagnosticValue(evt.channel),
    webhook: normalizeDiagnosticValue(evt.updateType),
  };
}

function recordDiagnosticEvent(
  store: PrometheusMetricStore,
  evt: DiagnosticEventPayload,
  metadata: DiagnosticEventMetadata,
): void {
  if (!metadata.trusted && !isInternalDiagnosticEventMetadata(metadata)) {
    return;
  }

  switch (evt.type) {
    case "worker.request":
      if (metadata.trusted) {
        recordWorkerRequest(store, evt);
      }
      return;
    case "diagnostic.phase.completed":
    case "gateway.rpc":
    case "gateway.http.cancelled":
    case "diagnostic.gc":
    case "gateway.event_loop.sample":
      recordOperationTimingEvent(store, evt, metadata);
      return;
    case "model.usage":
      recordModelUsage(store, evt);
      return;
    case "run.completed": {
      const labels = {
        ...(evt.blockedBy ? { blocked_by: normalizeDiagnosticValue(evt.blockedBy) } : {}),
        channel: normalizeDiagnosticValue(evt.channel),
        model: normalizeDiagnosticValue(evt.model),
        outcome: normalizeDiagnosticValue(evt.outcome, "unknown"),
        provider: normalizeDiagnosticValue(evt.provider),
        trigger: normalizeDiagnosticValue(evt.trigger),
      };
      store.histogram(
        "openclaw_run_duration_seconds",
        "Agent run duration in seconds.",
        labels,
        seconds(evt.durationMs),
        AGENT_DURATION_BUCKETS_SECONDS,
      );
      store.counter("openclaw_run_completed_total", "Agent runs completed by outcome.", labels);
      return;
    }
    case "model.call.completed":
    case "model.call.error": {
      const labels = {
        api: normalizeDiagnosticValue(evt.api),
        error_category:
          evt.type === "model.call.error"
            ? normalizeDiagnosticValue(evt.errorCategory, "other")
            : "none",
        model: normalizeDiagnosticValue(evt.model),
        observation_unit: evt.observationUnit === "turn" ? "turn" : "request",
        outcome: evt.type === "model.call.error" ? "error" : "completed",
        provider: normalizeDiagnosticValue(evt.provider),
        transport: normalizeDiagnosticValue(evt.transport),
      };
      store.histogram(
        "openclaw_model_call_duration_seconds",
        "Model request or synthetic agent-turn duration in seconds.",
        labels,
        seconds(evt.durationMs),
        AGENT_DURATION_BUCKETS_SECONDS,
      );
      store.counter(
        "openclaw_model_call_total",
        "Model requests or synthetic agent turns completed by outcome.",
        labels,
      );
      return;
    }
    case "model.failover": {
      const labels = {
        from_model: normalizeDiagnosticValue(evt.fromModel),
        from_provider: normalizeDiagnosticValue(evt.fromProvider),
        lane: normalizeDiagnosticLane(evt.lane),
        reason: normalizeDiagnosticValue(evt.reason, "other"),
        suspended: evt.suspended === undefined ? "unknown" : String(evt.suspended),
        to_model: normalizeDiagnosticValue(evt.toModel),
        to_provider: normalizeDiagnosticValue(evt.toProvider),
      };
      store.counter(
        "openclaw_model_failover_total",
        "Model failovers by source, destination, lane, and reason.",
        labels,
      );
      return;
    }
    case "tool.execution.completed":
    case "tool.execution.error": {
      const labels = {
        error_category:
          evt.type === "tool.execution.error"
            ? normalizeDiagnosticValue(evt.errorCategory, "other")
            : "none",
        outcome: evt.type === "tool.execution.error" ? "error" : "completed",
        params_kind: normalizeDiagnosticValue(evt.paramsSummary?.kind),
        tool: normalizeDiagnosticValue(evt.toolName, "tool"),
        tool_owner: normalizeDiagnosticValue(evt.toolOwner, "none"),
        tool_source: normalizeDiagnosticValue(evt.toolSource, "core"),
      };
      store.histogram(
        "openclaw_tool_execution_duration_seconds",
        "Tool execution duration in seconds.",
        labels,
        seconds(evt.durationMs),
      );
      store.counter(
        "openclaw_tool_execution_total",
        "Tool executions completed by outcome.",
        labels,
      );
      return;
    }
    case "tool.execution.blocked": {
      const labels = {
        denied_reason: normalizeDiagnosticValue(evt.deniedReason, "other"),
        params_kind: normalizeDiagnosticValue(evt.paramsSummary?.kind),
        tool: normalizeDiagnosticValue(evt.toolName, "tool"),
        tool_owner: normalizeDiagnosticValue(evt.toolOwner, "none"),
        tool_source: normalizeDiagnosticValue(evt.toolSource, "core"),
      };
      store.counter(
        "openclaw_tool_execution_blocked_total",
        "Tool executions blocked by policy or sandbox diagnostics.",
        labels,
      );
      return;
    }
    case "skill.used": {
      const labels = {
        activation: normalizeDiagnosticValue(evt.activation, "unknown"),
        agent: normalizeDiagnosticValue(evt.agentId),
        skill: normalizeDiagnosticValue(evt.skillName, "skill"),
        source: normalizeDiagnosticValue(evt.skillSource),
      };
      store.counter("openclaw_skill_used_total", "Skills used by agent runs.", labels);
      return;
    }
    case "harness.run.completed":
    case "harness.run.error": {
      const labels = {
        channel: normalizeDiagnosticValue(evt.channel),
        error_category:
          evt.type === "harness.run.error"
            ? normalizeDiagnosticValue(evt.errorCategory, "other")
            : "none",
        harness: normalizeDiagnosticValue(evt.harnessId),
        model: normalizeDiagnosticValue(evt.model),
        outcome: evt.type === "harness.run.error" ? "error" : normalizeDiagnosticValue(evt.outcome),
        phase: evt.type === "harness.run.error" ? normalizeDiagnosticValue(evt.phase) : "none",
        plugin: normalizeDiagnosticValue(evt.pluginId),
        provider: normalizeDiagnosticValue(evt.provider),
      };
      store.histogram(
        "openclaw_harness_run_duration_seconds",
        "Agent harness run duration in seconds.",
        labels,
        seconds(evt.durationMs),
        AGENT_DURATION_BUCKETS_SECONDS,
      );
      store.counter(
        "openclaw_harness_run_total",
        "Agent harness runs completed by outcome.",
        labels,
      );
      return;
    }
    case "message.processed": {
      const labels = {
        channel: normalizeDiagnosticValue(evt.channel),
        outcome: evt.outcome,
        reason: normalizeDiagnosticValue(evt.reason, "none"),
      };
      store.counter(
        "openclaw_message_processed_total",
        "Inbound messages processed by outcome.",
        labels,
      );
      store.histogram(
        "openclaw_message_processed_duration_seconds",
        "Inbound message processing duration in seconds.",
        labels,
        seconds(evt.durationMs),
      );
      return;
    }
    case "webhook.received":
      store.counter(
        "openclaw_webhook_received_total",
        "Webhook requests received by channel and update type.",
        webhookLabels(evt),
      );
      return;
    case "webhook.processed":
      store.histogram(
        "openclaw_webhook_duration_seconds",
        "Webhook processing duration in seconds.",
        webhookLabels(evt),
        seconds(evt.durationMs),
      );
      return;
    case "webhook.error":
      store.counter(
        "openclaw_webhook_error_total",
        "Webhook processing errors by channel and update type.",
        webhookLabels(evt),
      );
      return;
    case "message.delivery.started":
      store.counter(
        "openclaw_message_delivery_started_total",
        "Outbound message delivery attempts started.",
        {
          channel: normalizeDiagnosticValue(evt.channel),
          delivery_kind: normalizeDiagnosticValue(evt.deliveryKind, "other"),
        },
      );
      return;
    case "message.received":
      store.counter("openclaw_message_received_total", "Inbound messages received by channel.", {
        channel: normalizeDiagnosticValue(evt.channel),
        source: normalizeDiagnosticValue(evt.source),
      });
      return;
    case "message.dispatch.started":
      store.counter(
        "openclaw_message_dispatch_started_total",
        "Inbound message dispatch attempts started by channel.",
        {
          channel: normalizeDiagnosticValue(evt.channel),
          source: normalizeDiagnosticValue(evt.source),
        },
      );
      return;
    case "message.dispatch.completed": {
      const labels = {
        channel: normalizeDiagnosticValue(evt.channel),
        outcome: evt.outcome,
        reason: normalizeDiagnosticValue(evt.reason, "none"),
        source: normalizeDiagnosticValue(evt.source),
      };
      store.counter(
        "openclaw_message_dispatch_completed_total",
        "Inbound message dispatch attempts completed by outcome.",
        labels,
      );
      store.histogram(
        "openclaw_message_dispatch_duration_seconds",
        "Inbound message dispatch duration in seconds.",
        labels,
        seconds(evt.durationMs),
        AGENT_DURATION_BUCKETS_SECONDS,
      );
      return;
    }
    case "message.delivery.completed":
    case "message.delivery.error": {
      const labels = {
        channel: normalizeDiagnosticValue(evt.channel),
        delivery_kind: normalizeDiagnosticValue(evt.deliveryKind, "other"),
        error_category:
          evt.type === "message.delivery.error"
            ? normalizeDiagnosticValue(evt.errorCategory, "other")
            : "none",
        outcome: evt.type === "message.delivery.error" ? "error" : "completed",
      };
      store.counter(
        "openclaw_message_delivery_total",
        "Outbound message delivery attempts by outcome.",
        labels,
      );
      store.histogram(
        "openclaw_message_delivery_duration_seconds",
        "Outbound message delivery duration in seconds.",
        labels,
        seconds(evt.durationMs),
      );
      return;
    }
    case "talk.event": {
      const labels = {
        brain: normalizeDiagnosticValue(evt.brain),
        event_type: normalizeDiagnosticValue(evt.talkEventType),
        mode: normalizeDiagnosticValue(evt.mode),
        provider: normalizeDiagnosticValue(evt.provider),
        transport: normalizeDiagnosticValue(evt.transport),
      };
      store.counter("openclaw_talk_event_total", "Talk events emitted by type.", labels);
      store.histogram(
        "openclaw_talk_event_duration_seconds",
        "Talk event duration in seconds when reported.",
        labels,
        seconds(evt.durationMs),
      );
      store.histogram(
        "openclaw_talk_audio_bytes",
        "Talk audio frame byte lengths.",
        labels,
        numericValue(evt.byteLength),
        BYTE_BUCKETS,
      );
      return;
    }
    case "session.recovery.requested":
    case "session.recovery.completed":
      recordSessionDiagnosticEvent(store, evt);
      return;
    case "queue.lane.enqueue":
    case "queue.lane.dequeue":
      store.gauge(
        "openclaw_queue_lane_size",
        "Current diagnostic queue lane size.",
        {
          lane: normalizeDiagnosticLane(evt.lane),
        },
        numericValue(evt.queueSize),
      );
      if (evt.type === "queue.lane.dequeue") {
        store.histogram(
          "openclaw_queue_lane_wait_seconds",
          "Queue lane wait time in seconds.",
          { lane: normalizeDiagnosticLane(evt.lane) },
          seconds(evt.waitMs),
        );
      }
      return;
    case "session.state":
    case "session.stuck":
    case "session.turn.created":
      recordSessionDiagnosticEvent(store, evt);
      return;
    case "diagnostic.child_process.spawn":
      recordChildProcessSpawn(store, evt);
      return;
    case "diagnostic.memory.sample":
      recordMemorySample(store, evt.memory, BYTE_BUCKETS);
      return;
    case "diagnostic.memory.pressure":
      store.counter(
        "openclaw_memory_pressure_total",
        "Memory pressure events by level and reason.",
        {
          level: evt.level,
          reason: evt.reason,
        },
      );
      return;
    case "diagnostic.liveness.warning": {
      const labels = {
        reason: normalizeDiagnosticValue(evt.reasons.join(":"), "unknown"),
      };
      store.counter(
        "openclaw_liveness_warning_total",
        "Diagnostic liveness warning events.",
        labels,
      );
      for (const state of ["active", "waiting", "queued"] as const) {
        store.gauge(
          "openclaw_liveness_sessions",
          "Latest session counts reported with diagnostic liveness warnings.",
          { state },
          numericValue(evt[state]),
        );
      }
      store.histogram(
        "openclaw_liveness_event_loop_delay_p99_seconds",
        "P99 event-loop delay reported by diagnostic liveness warnings in seconds.",
        labels,
        seconds(evt.eventLoopDelayP99Ms),
      );
      store.histogram(
        "openclaw_liveness_event_loop_delay_max_seconds",
        "Maximum event-loop delay reported by diagnostic liveness warnings in seconds.",
        labels,
        seconds(evt.eventLoopDelayMaxMs),
      );
      store.histogram(
        "openclaw_liveness_event_loop_utilization_ratio",
        "Event-loop utilization reported by diagnostic liveness warnings.",
        labels,
        numericValue(evt.eventLoopUtilization),
        RATIO_BUCKETS,
      );
      store.histogram(
        "openclaw_liveness_cpu_core_ratio",
        "Whole-process CPU usage in core equivalents, including worker and native threads; can exceed 1.",
        labels,
        numericValue(evt.cpuCoreRatio),
        RATIO_BUCKETS,
      );
      return;
    }
    case "diagnostic.async_queue.dropped":
      for (const [dropClass, field] of [
        ["total", "droppedEvents"],
        ["trusted", "droppedTrustedEvents"],
        ["untrusted", "droppedUntrustedEvents"],
        ["priority", "droppedPriorityEvents"],
      ] as const) {
        if (field !== "droppedEvents" && evt[field] === undefined) {
          continue;
        }
        store.counter(
          "openclaw_diagnostic_async_queue_dropped_total",
          "Async diagnostic queue drops by dropped event class.",
          { drop_class: dropClass },
          numericValue(evt[field]),
        );
      }
      store.gauge(
        "openclaw_diagnostic_async_queue_length",
        "Latest async diagnostic queue length after a drop summary.",
        {},
        numericValue(evt.queueLength),
      );
      break;
    case "diagnostic.heartbeat":
      break;
    case "telemetry.exporter":
      store.counter("openclaw_telemetry_exporter_total", "Telemetry exporter lifecycle events.", {
        exporter: normalizeDiagnosticValue(evt.exporter),
        reason: normalizeDiagnosticValue(evt.reason, "none"),
        signal: evt.signal,
        status: evt.status,
      });
      return;
    case "payload.large": {
      const labels = {
        action: evt.action,
        channel: normalizeDiagnosticValue(evt.channel, "none"),
        plugin: normalizeDiagnosticValue(evt.pluginId, "none"),
        reason: normalizeDiagnosticValue(evt.reason, "none"),
        surface: normalizeDiagnosticValue(evt.surface, "unknown"),
      };
      store.counter(
        "openclaw_payload_large_total",
        "Oversized payload diagnostics by surface and action.",
        labels,
      );
      store.histogram(
        "openclaw_payload_large_bytes",
        "Oversized payload byte sizes by surface and action.",
        labels,
        numericValue(evt.bytes),
        BYTE_BUCKETS,
      );
    }
    default:
  }
}

// Gateway authentication applies the caller's named-role scope ceiling, but the route's own
// read authorization belongs to this plugin. Mirror the Gateway read implication set so a
// scope-narrowed operator identity cannot scrape diagnostics it may not read.
const METRICS_READ_SCOPE = "operator.read";
const METRICS_READ_IMPLYING_SCOPES = [
  METRICS_READ_SCOPE,
  "operator.write",
  "operator.admin",
] as const;

function hasMetricsReadScope(): boolean {
  const runtimeScopes = getPluginRuntimeGatewayRequestScope()?.client?.connect?.scopes;
  const scopes = Array.isArray(runtimeScopes) ? runtimeScopes : [];
  return METRICS_READ_IMPLYING_SCOPES.some((scope) => scopes.includes(scope));
}

function createMetricsHandler(store: PrometheusMetricStore): OpenClawPluginHttpRouteHandler {
  return (req: IncomingMessage, res: ServerResponse) => {
    // Fail closed before any metric rendering, including for HEAD probes that would
    // otherwise disclose the document size to an unauthorized caller.
    if (!hasMetricsReadScope()) {
      res.statusCode = 403;
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(`missing scope: ${METRICS_READ_SCOPE}`);
      return true;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      res.setHeader("Allow", "GET, HEAD");
      res.end("Method Not Allowed");
      return true;
    }

    const body = renderPrometheusMetrics(store);
    res.statusCode = 200;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
    res.setHeader("Content-Length", String(Buffer.byteLength(body)));
    if (req.method === "HEAD") {
      res.end();
      return true;
    }
    res.end(body);
    return true;
  };
}

type PrometheusExporterHealthUpdate = {
  signal: "metrics";
  transport: "prometheus-scrape";
  status: "started" | "dropped";
  reason?: "configured";
};
type TrustedExporterDiagnosticsBridge = NonNullable<
  OpenClawPluginServiceContext["internalDiagnostics"]
> & {
  reportExporterHealth?: (update: PrometheusExporterHealthUpdate) => void;
};

export function createDiagnosticsPrometheusExporter() {
  const store = createPrometheusMetricStore();
  let unsubscribe: (() => void) | undefined;
  let unsubscribeWork: (() => void) | undefined;
  let internalDiagnostics: TrustedExporterDiagnosticsBridge | undefined;
  const reportExporterStatus = (update: PrometheusExporterHealthUpdate) => {
    try {
      internalDiagnostics?.reportExporterHealth?.(update);
    } catch {
      // Exporter health must never affect the exporter lifecycle.
    }
    const { transport: _transport, ...event } = update;
    internalDiagnostics?.emit({
      type: "telemetry.exporter",
      exporter: "diagnostics-prometheus",
      ...event,
    });
  };

  const service = {
    id: "diagnostics-prometheus",
    start(ctx) {
      const subscribe = ctx.internalDiagnostics?.onEvent;
      if (!subscribe) {
        ctx.logger.error("diagnostics-prometheus: internal diagnostics capability unavailable");
        return;
      }
      const identity = isDiagnosticsEnabled(ctx.config)
        ? ctx.internalDiagnostics?.getRuntimeIdentity?.()
        : undefined;
      if (identity) {
        // Reserve one sample before event traffic; runtime identity must survive saturation.
        store.gauge(
          "openclaw_gateway_build_info",
          "Identity of the hosting process and its loaded build; not a health or exporter epoch.",
          {
            process_instance_id: identity.processInstanceId,
            ...(identity.buildId ? { build_id: identity.buildId } : {}),
          },
          1,
        );
      }
      unsubscribeWork = ctx.internalDiagnostics?.onGatewayWorkMetrics?.(
        createGatewayWorkMetricsRecorder(store),
      );
      unsubscribe = subscribe(
        (event, metadata) => {
          try {
            recordDiagnosticEvent(store, event, metadata);
          } catch (err) {
            ctx.logger.error(
              `diagnostics-prometheus: event handler failed (${event.type}): ${safeErrorMessage(err)}`,
            );
          }
        },
        // Metrics do not consume logs; avoid enabling their diagnostic copy/formatting path.
        { exclude: ["log.record"] },
        { includePrivateData: false },
      );
      internalDiagnostics = ctx.internalDiagnostics;
      reportExporterStatus({
        signal: "metrics",
        transport: "prometheus-scrape",
        status: "started",
        reason: "configured",
      });
    },
    stop() {
      unsubscribeWork?.();
      unsubscribeWork = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      reportExporterStatus({
        signal: "metrics",
        transport: "prometheus-scrape",
        status: "dropped",
      });
      internalDiagnostics = undefined;
      store.reset();
    },
  } satisfies OpenClawPluginService;

  return {
    handler: createMetricsHandler(store),
    render: () => renderPrometheusMetrics(store),
    service,
  };
}
