import type { Meter } from "@opentelemetry/api";
import {
  AGENT_DURATION_MS_BUCKETS,
  CONTEXT_TOKENS_BUCKETS,
  GEN_AI_OPERATION_DURATION_BUCKETS,
  GEN_AI_TOKEN_USAGE_BUCKETS,
} from "./service-constants.js";

const DEFAULT_METRIC_NAME_PREFIX = "openclaw.";

export function createDiagnosticsMetrics(
  meter: Meter,
  metricNamePrefix = DEFAULT_METRIC_NAME_PREFIX,
) {
  const createCounter = (name: string, description: string, unit = "1") =>
    meter.createCounter(`${metricNamePrefix}${name}`, { unit, description });
  const createHistogram = (
    name: string,
    description: string,
    unit = "ms",
    explicitBucketBoundaries?: number[],
  ) =>
    meter.createHistogram(`${metricNamePrefix}${name}`, {
      unit,
      description,
      ...(explicitBucketBoundaries ? { advice: { explicitBucketBoundaries } } : {}),
    });

  return {
    gcDurationHistogram: createHistogram(
      "gc.duration_ms",
      "Elapsed garbage collection duration for the hosting JavaScript isolate",
      "ms",
      AGENT_DURATION_MS_BUCKETS,
    ),
    gatewayEventLoopDelayMaxHistogram: createHistogram(
      "gateway.event_loop.delay_max_ms",
      "Maximum event-loop delay per completed Gateway observation window",
      "ms",
      AGENT_DURATION_MS_BUCKETS,
    ),
    gatewayEventLoopObservedCounter: createCounter(
      "gateway.event_loop.observed_ms",
      "Elapsed time covered by completed Gateway event-loop observation windows",
      "ms",
    ),
    gatewayRpcRequestsCounter: createCounter(
      "gateway.rpc.requests",
      "Authenticated Gateway WebSocket requests received",
    ),
    gatewayRpcOutcomesCounter: createCounter(
      "gateway.rpc.outcomes",
      "Gateway RPC observations by phase and outcome",
    ),
    gatewayRpcFirstResponseHistogram: createHistogram(
      "gateway.rpc.first_response_ms",
      "Elapsed time until the first Gateway RPC response is sent",
      "ms",
      AGENT_DURATION_MS_BUCKETS,
    ),
    gatewayRpcHandlerHistogram: createHistogram(
      "gateway.rpc.handler_ms",
      "Gateway RPC handler duration until return or throw",
      "ms",
      AGENT_DURATION_MS_BUCKETS,
    ),
    gatewayRpcAdmissionHistogram: createHistogram(
      "gateway.rpc.admission_ms",
      "Elapsed time from Gateway RPC receipt until handler invocation",
      "ms",
      AGENT_DURATION_MS_BUCKETS,
    ),
    gatewayRpcQueueWaitHistogram: createHistogram(
      "gateway.rpc.queue_wait_ms",
      "Gateway operator start queue or worker frame queue wait",
      "ms",
      AGENT_DURATION_MS_BUCKETS,
    ),
    tokensCounter: createCounter("tokens", "Token usage by type"),
    genAiTokenUsageHistogram: meter.createHistogram("gen_ai.client.token.usage", {
      unit: "{token}",
      description: "Number of input and output tokens used by GenAI client operations",
      advice: {
        explicitBucketBoundaries: GEN_AI_TOKEN_USAGE_BUCKETS,
      },
    }),
    genAiOperationDurationHistogram: meter.createHistogram("gen_ai.client.operation.duration", {
      unit: "s",
      description: "GenAI client operation duration",
      advice: {
        explicitBucketBoundaries: GEN_AI_OPERATION_DURATION_BUCKETS,
      },
    }),
    costCounter: createCounter("cost.usd", "Estimated model cost (USD)"),
    durationHistogram: createHistogram(
      "run.duration_ms",
      "Agent run duration",
      "ms",
      AGENT_DURATION_MS_BUCKETS,
    ),
    harnessDurationHistogram: createHistogram(
      "harness.duration_ms",
      "Agent harness lifecycle duration",
      "ms",
      AGENT_DURATION_MS_BUCKETS,
    ),
    contextHistogram: createHistogram(
      "context.tokens",
      "Context window size and usage",
      "1",
      CONTEXT_TOKENS_BUCKETS,
    ),
    webhookReceivedCounter: createCounter("webhook.received", "Webhook requests received"),
    webhookErrorCounter: createCounter("webhook.error", "Webhook processing errors"),
    webhookDurationHistogram: createHistogram("webhook.duration_ms", "Webhook processing duration"),
    messageQueuedCounter: createCounter("message.queued", "Messages queued for processing"),
    messageReceivedCounter: createCounter("message.received", "Inbound messages received"),
    messageDispatchStartedCounter: createCounter(
      "message.dispatch.started",
      "Inbound message dispatch attempts started",
    ),
    messageDispatchCompletedCounter: createCounter(
      "message.dispatch.completed",
      "Inbound message dispatch attempts completed",
    ),
    messageDispatchDurationHistogram: createHistogram(
      "message.dispatch.duration_ms",
      "Inbound message dispatch duration",
    ),
    messageProcessedCounter: createCounter("message.processed", "Messages processed by outcome"),
    messageDurationHistogram: createHistogram("message.duration_ms", "Message processing duration"),
    messageDeliveryStartedCounter: createCounter(
      "message.delivery.started",
      "Outbound message delivery attempts started",
    ),
    messageDeliveryDurationHistogram: createHistogram(
      "message.delivery.duration_ms",
      "Outbound message delivery duration",
    ),
    queueDepthHistogram: createHistogram("queue.depth", "Queue depth on enqueue/dequeue", "1"),
    queueWaitHistogram: createHistogram("queue.wait_ms", "Queue wait time before execution"),
    laneEnqueueCounter: createCounter("queue.lane.enqueue", "Command queue lane enqueue events"),
    laneDequeueCounter: createCounter("queue.lane.dequeue", "Command queue lane dequeue events"),
    sessionStateCounter: createCounter("session.state", "Session state transitions"),
    sessionTurnCreatedCounter: createCounter("session.turn.created", "Agent session turns created"),
    sessionStuckCounter: createCounter("session.stuck", "Sessions stuck in processing"),
    sessionStuckAgeHistogram: createHistogram("session.stuck_age_ms", "Age of stuck sessions"),
    sessionRecoveryRequestedCounter: createCounter(
      "session.recovery.requested",
      "Session recovery attempts requested",
    ),
    sessionRecoveryCompletedCounter: createCounter(
      "session.recovery.completed",
      "Session recovery attempts completed",
    ),
    sessionRecoveryAgeHistogram: createHistogram(
      "session.recovery.age_ms",
      "Age of sessions selected for recovery",
    ),
    talkEventCounter: createCounter("talk.event", "Talk events emitted by type"),
    talkEventDurationHistogram: createHistogram(
      "talk.event.duration_ms",
      "Talk event duration when reported",
    ),
    talkAudioBytesHistogram: createHistogram(
      "talk.audio.bytes",
      "Talk audio frame byte lengths",
      "By",
    ),
    runAttemptCounter: createCounter("run.attempt", "Run attempts"),
    toolLoopCounter: createCounter("tool.loop", "Detected repetitive tool-call loop events"),
    skillUsedCounter: createCounter("skill.used", "Skills used by agent runs"),
    modelCallDurationHistogram: createHistogram("model_call.duration_ms", "Model call duration"),
    modelCallRequestBytesHistogram: createHistogram(
      "model_call.request_bytes",
      "UTF-8 byte size of sanitized model request payloads",
      "By",
    ),
    modelCallResponseBytesHistogram: createHistogram(
      "model_call.response_bytes",
      "UTF-8 byte size of bounded streamed model response payloads",
      "By",
    ),
    modelCallTimeToFirstByteHistogram: createHistogram(
      "model_call.time_to_first_byte_ms",
      "Elapsed time before the first streamed model response event",
    ),
    modelFailoverCounter: createCounter(
      "model.failover",
      "Model failovers by source, destination, lane, and reason",
    ),
    toolExecutionDurationHistogram: createHistogram(
      "tool.execution.duration_ms",
      "Tool execution duration",
    ),
    toolExecutionBlockedCounter: createCounter(
      "tool.execution.blocked",
      "Tool executions blocked by policy or sandbox diagnostics",
    ),
    execProcessDurationHistogram: createHistogram("exec.duration_ms", "Exec process duration"),
    memoryRssHistogram: createHistogram(
      "memory.rss_bytes",
      "Resident set size reported by diagnostic memory samples",
      "By",
    ),
    memoryHeapUsedHistogram: createHistogram(
      "memory.heap_used_bytes",
      "Heap used bytes reported by diagnostic memory samples",
      "By",
    ),
    memoryHeapTotalHistogram: createHistogram(
      "memory.heap_total_bytes",
      "Heap total bytes reported by diagnostic memory samples",
      "By",
    ),
    memoryExternalHistogram: createHistogram(
      "memory.external_bytes",
      "External memory bytes reported by diagnostic memory samples",
      "By",
    ),
    memoryArrayBuffersHistogram: createHistogram(
      "memory.array_buffers_bytes",
      "ArrayBuffer bytes reported by diagnostic memory samples",
      "By",
    ),
    memoryPressureCounter: createCounter("memory.pressure", "Diagnostic memory pressure events"),
    asyncQueueDroppedCounter: createCounter(
      "diagnostic.async_queue.dropped",
      "Async diagnostic queue drops by dropped event class",
    ),
    payloadLargeCounter: createCounter(
      "payload.large",
      "Oversized payload diagnostics by surface and action",
    ),
    payloadLargeBytesHistogram: createHistogram(
      "payload.large_bytes",
      "Oversized payload byte sizes by surface and action",
      "By",
    ),
    livenessWarningCounter: createCounter("liveness.warning", "Diagnostic liveness warning events"),
    livenessEventLoopDelayP99Histogram: createHistogram(
      "liveness.event_loop_delay_p99_ms",
      "P99 event-loop delay reported by diagnostic liveness warnings",
    ),
    livenessEventLoopDelayMaxHistogram: createHistogram(
      "liveness.event_loop_delay_max_ms",
      "Maximum event-loop delay reported by diagnostic liveness warnings",
    ),
    livenessEventLoopUtilizationHistogram: createHistogram(
      "liveness.event_loop_utilization",
      "Event-loop utilization reported by diagnostic liveness warnings",
      "1",
    ),
    livenessCpuCoreRatioHistogram: createHistogram(
      "liveness.cpu_core_ratio",
      "Whole-process CPU usage in core equivalents, including worker and native threads; can exceed 1.",
      "1",
    ),
    telemetryExporterCounter: createCounter(
      "telemetry.exporter.events",
      "Diagnostic telemetry exporter lifecycle and failure events",
    ),
  };
}

export type DiagnosticsMetrics = ReturnType<typeof createDiagnosticsMetrics>;
