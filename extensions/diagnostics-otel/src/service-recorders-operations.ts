import { ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import {
  normalizeDiagnosticValue,
  normalizeDiagnosticLane,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOtelErrorMessage } from "./service-content-normalization.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { SessionRecoveryDiagnosticEvent, TalkDiagnosticEvent } from "./service-types.js";

export function createOperationsRecorders(runtime: DiagnosticsRecorderRuntime) {
  const sessionRecoveryAttrs = (evt: SessionRecoveryDiagnosticEvent) => {
    const attrs: Record<string, string> = { "openclaw.state": evt.state };
    if (evt.reason) {
      attrs["openclaw.reason"] = redactSensitiveText(evt.reason);
    }
    if (evt.activeWorkKind) {
      attrs["openclaw.active_work_kind"] = evt.activeWorkKind;
    }
    return attrs;
  };

  const recordMemoryUsageMetrics = (
    evt: Extract<
      DiagnosticEventPayload,
      { type: "diagnostic.memory.sample" | "diagnostic.memory.pressure" }
    >,
    attrs: Record<string, string> = {},
  ) => {
    runtime.memoryRssHistogram.record(evt.memory.rssBytes, attrs);
    runtime.memoryHeapUsedHistogram.record(evt.memory.heapUsedBytes, attrs);
    runtime.memoryHeapTotalHistogram.record(evt.memory.heapTotalBytes, attrs);
    runtime.memoryExternalHistogram.record(evt.memory.externalBytes, attrs);
    runtime.memoryArrayBuffersHistogram.record(evt.memory.arrayBuffersBytes, attrs);
  };

  return {
    recordGatewayRpc(
      evt: Extract<DiagnosticEventPayload, { type: "gateway.rpc" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      if (!metadata.trusted || (evt.phase === "response" && evt.firstResponse === false)) {
        return;
      }
      const attrs = { "openclaw.gateway.rpc.method": evt.method };
      if (evt.phase === "received") {
        runtime.gatewayRpcRequestsCounter.add(1, attrs);
        return;
      }
      const outcomeAttrs = {
        "openclaw.gateway.rpc.phase": evt.phase,
        "openclaw.gateway.rpc.outcome": evt.outcome,
      };
      runtime.gatewayRpcOutcomesCounter.add(1, outcomeAttrs);
      switch (evt.phase) {
        case "response":
          if (evt.outcome === "ok" || evt.outcome === "error") {
            runtime.gatewayRpcFirstResponseHistogram.record(evt.durationMs, attrs);
          }
          break;
        case "handler":
          runtime.gatewayRpcHandlerHistogram.record(evt.durationMs, attrs);
          runtime.gatewayRpcAdmissionHistogram.record(evt.admissionMs, attrs);
          break;
        case "dispatch":
          if (evt.queueWaitMs !== undefined) {
            runtime.gatewayRpcQueueWaitHistogram.record(evt.queueWaitMs, attrs);
          }
          break;
      }
      if (!runtime.tracesEnabled) {
        return;
      }
      // These completed observations do not own the handler or later response callbacks.
      // Preserve the explicit upstream parent; an absent parent must not borrow the export callback scope.
      const span = runtime.spanWithDuration(
        `openclaw.gateway.rpc.${evt.phase}`,
        {
          ...attrs,
          ...outcomeAttrs,
          ...(evt.phase === "handler"
            ? { "openclaw.gateway.rpc.admission_ms": evt.admissionMs }
            : {}),
          ...(evt.phase === "dispatch" ? { "openclaw.gateway.rpc.response": evt.response } : {}),
        },
        evt.durationMs,
        {
          endTimeMs: evt.ts,
          parentContext:
            runtime.internalOrTrustedExplicitParentContext(evt, metadata) ?? ROOT_CONTEXT,
        },
      );
      if (evt.outcome === "error" || evt.outcome === "threw") {
        span.setStatus({ code: SpanStatusCode.ERROR });
      }
      span.end(evt.ts);
    },
    recordLaneEnqueue(evt: Extract<DiagnosticEventPayload, { type: "queue.lane.enqueue" }>) {
      const attrs = { "openclaw.lane": normalizeDiagnosticLane(evt.lane) };
      runtime.laneEnqueueCounter.add(1, attrs);
      runtime.queueDepthHistogram.record(evt.queueSize, attrs);
    },
    recordLaneDequeue(evt: Extract<DiagnosticEventPayload, { type: "queue.lane.dequeue" }>) {
      const attrs = { "openclaw.lane": normalizeDiagnosticLane(evt.lane) };
      runtime.laneDequeueCounter.add(1, attrs);
      runtime.queueDepthHistogram.record(evt.queueSize, attrs);
      if (typeof evt.waitMs === "number") {
        runtime.queueWaitHistogram.record(evt.waitMs, attrs);
      }
    },
    recordSessionState(evt: Extract<DiagnosticEventPayload, { type: "session.state" }>) {
      const attrs: Record<string, string> = { "openclaw.state": evt.state };
      if (evt.reason) {
        attrs["openclaw.reason"] = redactSensitiveText(evt.reason);
      }
      runtime.sessionStateCounter.add(1, attrs);
    },
    recordSessionTurnCreated(
      evt: Extract<DiagnosticEventPayload, { type: "session.turn.created" }>,
    ) {
      runtime.sessionTurnCreatedCounter.add(1, {
        "openclaw.agent": normalizeDiagnosticValue(evt.agentId, "unknown"),
        "openclaw.channel": normalizeDiagnosticValue(evt.channel, "unknown"),
        "openclaw.trigger": evt.trigger,
      });
    },
    recordSessionStuck(evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>) {
      const attrs: Record<string, string> = { "openclaw.state": evt.state };
      runtime.sessionStuckCounter.add(1, attrs);
      if (typeof evt.ageMs === "number") {
        runtime.sessionStuckAgeHistogram.record(evt.ageMs, attrs);
      }
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number> = { ...attrs };
      spanAttrs["openclaw.queueDepth"] = evt.queueDepth ?? 0;
      spanAttrs["openclaw.ageMs"] = evt.ageMs;
      const span = runtime.tracer.startSpan("openclaw.session.stuck", { attributes: spanAttrs });
      span.setStatus({ code: SpanStatusCode.ERROR, message: "session stuck" });
      span.end();
    },
    recordSessionRecoveryRequested(
      evt: Extract<DiagnosticEventPayload, { type: "session.recovery.requested" }>,
    ) {
      const attrs = sessionRecoveryAttrs(evt);
      attrs["openclaw.action"] = evt.allowActiveAbort ? "abort" : "recover";
      runtime.sessionRecoveryRequestedCounter.add(1, attrs);
      runtime.sessionRecoveryAgeHistogram.record(evt.ageMs, attrs);
    },
    recordSessionRecoveryCompleted(
      evt: Extract<DiagnosticEventPayload, { type: "session.recovery.completed" }>,
    ) {
      const attrs = sessionRecoveryAttrs(evt);
      attrs["openclaw.status"] = evt.status;
      attrs["openclaw.action"] = normalizeDiagnosticValue(evt.action, "unknown");
      if (evt.outcomeReason) {
        attrs["openclaw.reason"] = redactSensitiveText(evt.outcomeReason);
      }
      runtime.sessionRecoveryCompletedCounter.add(1, attrs);
      runtime.sessionRecoveryAgeHistogram.record(evt.ageMs, attrs);
    },
    recordTalkEvent(evt: TalkDiagnosticEvent, metadata: DiagnosticEventMetadata) {
      if (!metadata.trusted) {
        return;
      }
      const attrs = {
        "openclaw.talk.brain": normalizeDiagnosticValue(evt.brain),
        "openclaw.talk.event_type": normalizeDiagnosticValue(evt.talkEventType),
        "openclaw.talk.mode": normalizeDiagnosticValue(evt.mode),
        "openclaw.talk.provider": normalizeDiagnosticValue(evt.provider),
        "openclaw.talk.transport": normalizeDiagnosticValue(evt.transport),
      };
      runtime.talkEventCounter.add(1, attrs);
      if (typeof evt.durationMs === "number") {
        runtime.talkEventDurationHistogram.record(evt.durationMs, attrs);
      }
      if (typeof evt.byteLength === "number") {
        runtime.talkAudioBytesHistogram.record(evt.byteLength, attrs);
      }
    },
    recordRunAttempt(evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>) {
      runtime.runAttemptCounter.add(1, { "openclaw.attempt": evt.attempt });
    },
    recordToolLoop(evt: Extract<DiagnosticEventPayload, { type: "tool.loop" }>) {
      const attrs = {
        "openclaw.toolName": normalizeDiagnosticValue(evt.toolName, "tool"),
        "openclaw.loop.level": evt.level,
        "openclaw.loop.action": evt.action,
        "openclaw.loop.detector": evt.detector,
        "openclaw.loop.count": evt.count,
        ...(evt.pairedToolName
          ? { "openclaw.loop.paired_tool": normalizeDiagnosticValue(evt.pairedToolName, "tool") }
          : {}),
      };
      runtime.toolLoopCounter.add(1, attrs);
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = { ...attrs };
      runtime.addRunAttrs(spanAttrs, evt);
      const span = runtime.spanWithDuration("openclaw.tool.loop", spanAttrs, 0, {
        endTimeMs: evt.ts,
      });
      if (evt.level === "critical" || evt.action === "block") {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: `${evt.detector}:${evt.action}`,
        });
      }
      span.end(evt.ts);
    },
    recordMemoryUsageMetrics,
    recordMemoryPressure(
      evt: Extract<DiagnosticEventPayload, { type: "diagnostic.memory.pressure" }>,
    ) {
      const attrs = {
        "openclaw.memory.level": evt.level,
        "openclaw.memory.reason": evt.reason,
      };
      runtime.memoryPressureCounter.add(1, attrs);
      recordMemoryUsageMetrics(evt, attrs);
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = {
        ...attrs,
        "openclaw.memory.rss_bytes": evt.memory.rssBytes,
        "openclaw.memory.heap_used_bytes": evt.memory.heapUsedBytes,
        "openclaw.memory.heap_total_bytes": evt.memory.heapTotalBytes,
        "openclaw.memory.external_bytes": evt.memory.externalBytes,
        "openclaw.memory.array_buffers_bytes": evt.memory.arrayBuffersBytes,
        ...(evt.thresholdBytes !== undefined
          ? { "openclaw.memory.threshold_bytes": evt.thresholdBytes }
          : {}),
        ...(evt.rssGrowthBytes !== undefined
          ? { "openclaw.memory.rss_growth_bytes": evt.rssGrowthBytes }
          : {}),
        ...(evt.windowMs !== undefined ? { "openclaw.memory.window_ms": evt.windowMs } : {}),
      };
      const span = runtime.spanWithDuration("openclaw.memory.pressure", spanAttrs, 0, {
        endTimeMs: evt.ts,
      });
      if (evt.level === "critical") {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: evt.reason,
        });
      }
      span.end(evt.ts);
    },
    recordAsyncQueueDropped(
      evt: Extract<DiagnosticEventPayload, { type: "diagnostic.async_queue.dropped" }>,
    ) {
      runtime.asyncQueueDroppedCounter.add(evt.droppedEvents, {
        "openclaw.diagnostic.async_queue.drop_class": "total",
      });
      for (const [dropClass, field] of [
        ["trusted", "droppedTrustedEvents"],
        ["untrusted", "droppedUntrustedEvents"],
        ["priority", "droppedPriorityEvents"],
      ] as const) {
        if (evt[field] !== undefined) {
          runtime.asyncQueueDroppedCounter.add(evt[field], {
            "openclaw.diagnostic.async_queue.drop_class": dropClass,
          });
        }
      }
    },
    recordRunCompleted(
      evt: Extract<DiagnosticEventPayload, { type: "run.completed" }>,
      metadata: DiagnosticEventMetadata,
      privateData: DiagnosticEventPrivateData,
    ) {
      const attrs: Record<string, string | number> = {
        "openclaw.outcome": evt.outcome,
        "openclaw.provider": evt.provider ?? "unknown",
        "openclaw.model": evt.model ?? "unknown",
      };
      if (evt.channel) {
        attrs["openclaw.channel"] = evt.channel;
      }
      if (evt.blockedBy) {
        attrs["openclaw.blocked_by"] = normalizeDiagnosticValue(evt.blockedBy, "unknown");
      }
      runtime.durationHistogram.record(evt.durationMs, attrs);
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = {
        "openclaw.outcome": evt.outcome,
      };
      runtime.addRunAttrs(spanAttrs, evt);
      if (evt.blockedBy) {
        spanAttrs["openclaw.blocked_by"] = normalizeDiagnosticValue(evt.blockedBy, "unknown");
      }
      if (evt.errorCategory) {
        spanAttrs["openclaw.errorCategory"] = normalizeDiagnosticValue(evt.errorCategory, "other");
      }
      // Redacted message goes on the span only, never the low-cardinality metric attrs.
      const redactedError = normalizeOtelErrorMessage(privateData.errorMessage);
      if (redactedError) {
        spanAttrs["openclaw.error"] = redactedError;
      }
      const trustedTrace = runtime.trustedTraceContext(evt, metadata);
      const trackedSpan = trustedTrace?.spanId
        ? runtime.activeTrustedSpans.get(trustedTrace.spanId)
        : undefined;
      const span =
        trackedSpan ??
        runtime.spanWithDuration("openclaw.run", spanAttrs, evt.durationMs, {
          parentContext: runtime.activeTrustedParentContext(evt, metadata),
          endTimeMs: evt.ts,
        });
      runtime.setSpanAttrs(span, spanAttrs);
      if (evt.outcome === "error") {
        const message =
          redactedError ?? (evt.errorCategory ? redactSensitiveText(evt.errorCategory) : undefined);
        span.setStatus({
          code: SpanStatusCode.ERROR,
          ...(message ? { message } : {}),
        });
      }
      runtime.completeTrackedLifecycleSpan(trackedSpan ? trustedTrace : undefined, span, evt.ts);
    },
  };
}
