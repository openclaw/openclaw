import { ROOT_CONTEXT, SpanStatusCode } from "@opentelemetry/api";
import {
  isInternalDiagnosticEventMetadata,
  normalizeDiagnosticValue,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { asPositiveFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { assignOptionalNumberAttrs } from "./service-attributes.js";
import {
  assignOtelToolContentAttributes,
  assignOtelToolIdentityAttributes,
} from "./service-genai-content.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { TelemetryExporterDiagnosticEvent } from "./service-types.js";

export function createToolAndSystemRecorders(runtime: DiagnosticsRecorderRuntime) {
  const toolExecutionBaseAttrs = (
    evt: Extract<
      DiagnosticEventPayload,
      {
        type:
          | "tool.execution.started"
          | "tool.execution.completed"
          | "tool.execution.error"
          | "tool.execution.blocked";
      }
    >,
  ): Record<string, string | number | boolean> => ({
    "openclaw.toolName": evt.toolName,
    "openclaw.tool.source": normalizeDiagnosticValue(evt.toolSource, "core"),
    "gen_ai.tool.name": evt.toolName,
    ...(evt.toolOwner ? { "openclaw.tool.owner": normalizeDiagnosticValue(evt.toolOwner) } : {}),
    ...runtime.paramsSummaryAttrs(evt.paramsSummary),
  });
  const toolTimestampMs = (evt: { sourceTimestampMs?: number; ts: number }) =>
    evt.sourceTimestampMs ?? evt.ts;

  return {
    recordGcDuration(
      evt: Extract<DiagnosticEventPayload, { type: "diagnostic.gc" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      if (!metadata.trusted && !isInternalDiagnosticEventMetadata(metadata)) {
        return;
      }
      runtime.gcDurationHistogram.record(evt.durationMs, undefined, ROOT_CONTEXT);
    },
    recordGatewayEventLoopSample(
      evt: Extract<DiagnosticEventPayload, { type: "gateway.event_loop.sample" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      if (!metadata.trusted && !isInternalDiagnosticEventMetadata(metadata)) {
        return;
      }
      // Process-wide windows must not inherit the reader's trace through an external SDK.
      runtime.gatewayEventLoopDelayMaxHistogram.record(evt.delayMaxMs, undefined, ROOT_CONTEXT);
      runtime.gatewayEventLoopObservedCounter.add(evt.intervalMs, undefined, ROOT_CONTEXT);
    },
    recordSkillUsed(
      evt: Extract<DiagnosticEventPayload, { type: "skill.used" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      if (!metadata.trusted) {
        return;
      }
      const attrs = {
        "openclaw.skill.name": normalizeDiagnosticValue(evt.skillName, "skill"),
        "openclaw.skill.source": normalizeDiagnosticValue(evt.skillSource),
        "openclaw.skill.activation": normalizeDiagnosticValue(evt.activation),
        ...(evt.agentId ? { "openclaw.agent": normalizeDiagnosticValue(evt.agentId) } : {}),
        ...(evt.toolName
          ? { "openclaw.toolName": normalizeDiagnosticValue(evt.toolName, "tool") }
          : {}),
      };
      runtime.skillUsedCounter.add(1, attrs);
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = {
        ...attrs,
        // Span-only bundle provenance: counters and metrics stay fingerprint-free.
        ...(evt.skillFingerprint
          ? { "openclaw.skill.fingerprint": normalizeDiagnosticValue(evt.skillFingerprint) }
          : {}),
      };
      runtime.addRunAttrs(spanAttrs, evt);
      const span = runtime.spanWithDuration("openclaw.skill.used", spanAttrs, 0, {
        parentContext: runtime.activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
      runtime.setSpanAttrs(span, spanAttrs);
      span.end(evt.ts);
    },
    recordToolExecutionStarted(
      evt: Extract<DiagnosticEventPayload, { type: "tool.execution.started" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      if (!runtime.tracesEnabled || !metadata.trusted) {
        return undefined;
      }
      const trackedSpan = runtime.getTrackedInternalOrTrustedSpan(evt, metadata);
      if (trackedSpan) {
        return trackedSpan.spanContext();
      }
      const spanAttrs = toolExecutionBaseAttrs(evt);
      assignOtelToolIdentityAttributes(spanAttrs, evt);
      return runtime
        .trackTrustedSpan(
          evt,
          metadata,
          runtime.spanWithDuration("openclaw.tool.execution", spanAttrs, undefined, {
            parentContext: runtime.activeTrustedParentContext(evt, metadata),
            startTimeMs: toolTimestampMs(evt),
          }),
        )
        .spanContext();
    },
    recordToolExecutionFinished(
      evt: Extract<
        DiagnosticEventPayload,
        { type: "tool.execution.completed" | "tool.execution.error" }
      >,
      metadata: DiagnosticEventMetadata,
      toolContent?: DiagnosticEventPrivateData["toolContent"],
    ) {
      const attrs = toolExecutionBaseAttrs(evt);
      if (evt.type === "tool.execution.error") {
        attrs["openclaw.errorCategory"] = normalizeDiagnosticValue(evt.errorCategory, "other");
      }
      runtime.toolExecutionDurationHistogram.record(evt.durationMs, attrs);
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = { ...attrs };
      runtime.addRunAttrs(spanAttrs, evt);
      assignOtelToolIdentityAttributes(spanAttrs, evt);
      if (evt.type === "tool.execution.error" && evt.errorCode) {
        spanAttrs["openclaw.errorCode"] = normalizeDiagnosticValue(evt.errorCode, "other");
      }
      assignOtelToolContentAttributes(spanAttrs, toolContent, runtime.captureContent);
      const span =
        runtime.takeTrackedTrustedSpan(evt, metadata) ??
        runtime.spanWithDuration("openclaw.tool.execution", spanAttrs, evt.durationMs, {
          parentContext: runtime.activeTrustedParentContext(evt, metadata),
          endTimeMs: toolTimestampMs(evt),
        });
      runtime.setSpanAttrs(span, spanAttrs);
      if (evt.type === "tool.execution.error") {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: redactSensitiveText(evt.errorCategory),
        });
      }
      span.end(toolTimestampMs(evt));
    },
    recordToolExecutionBlocked(
      evt: Extract<DiagnosticEventPayload, { type: "tool.execution.blocked" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      runtime.toolExecutionBlockedCounter.add(1, {
        ...toolExecutionBaseAttrs(evt),
        "openclaw.deniedReason": normalizeDiagnosticValue(evt.deniedReason, "other"),
      });
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = {
        ...toolExecutionBaseAttrs(evt),
        "openclaw.outcome": "blocked",
        "openclaw.deniedReason": normalizeDiagnosticValue(evt.deniedReason, "other"),
      };
      runtime.addRunAttrs(spanAttrs, evt);
      assignOtelToolIdentityAttributes(spanAttrs, evt);
      const span =
        runtime.takeTrackedTrustedSpan(evt, metadata) ??
        runtime.spanWithDuration("openclaw.tool.execution", spanAttrs, 0, {
          parentContext: runtime.activeTrustedParentContext(evt, metadata),
          endTimeMs: toolTimestampMs(evt),
        });
      runtime.setSpanAttrs(span, spanAttrs);
      span.end(toolTimestampMs(evt));
    },
    recordPayloadLarge(evt: Extract<DiagnosticEventPayload, { type: "payload.large" }>) {
      const attrs = {
        "openclaw.payload.action": evt.action,
        "openclaw.payload.surface": normalizeDiagnosticValue(evt.surface, "unknown"),
        "openclaw.channel": normalizeDiagnosticValue(evt.channel, "none"),
        "openclaw.plugin": normalizeDiagnosticValue(evt.pluginId, "none"),
        "openclaw.reason": normalizeDiagnosticValue(evt.reason, "none"),
      };
      runtime.payloadLargeCounter.add(1, attrs);
      const bytes = asPositiveFiniteNumber(evt.bytes);
      if (bytes !== undefined) {
        runtime.payloadLargeBytesHistogram.record(bytes, attrs);
      }
    },
    recordExecProcessCompleted(
      evt: Extract<DiagnosticEventPayload, { type: "exec.process.completed" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      const attrs: Record<string, string | number> = {
        "openclaw.exec.target": evt.target,
        "openclaw.exec.mode": evt.mode,
        "openclaw.outcome": evt.outcome,
      };
      if (evt.failureKind) {
        attrs["openclaw.failureKind"] = evt.failureKind;
      }
      runtime.execProcessDurationHistogram.record(evt.durationMs, attrs);
      if (!runtime.tracesEnabled) {
        return;
      }

      const spanAttrs: Record<string, string | number | boolean> = {
        ...attrs,
        "openclaw.exec.command_length": evt.commandLength,
      };
      if (typeof evt.exitCode === "number") {
        spanAttrs["openclaw.exec.exit_code"] = evt.exitCode;
      }
      if (evt.exitSignal) {
        spanAttrs["openclaw.exec.exit_signal"] = normalizeDiagnosticValue(evt.exitSignal, "other");
      }
      if (evt.timedOut !== undefined) {
        spanAttrs["openclaw.exec.timed_out"] = evt.timedOut;
      }

      // Exec events carry the innermost ambient scope rather than a child context, so
      // the parent is looked up by the event's own span id first. For the openclaw
      // harness that scope is the harness run (no run scope is opened -
      // shouldEmitAgentRunDiagnostics is false there), so the parent is
      // openclaw.harness.run; other harnesses open a run scope and parent to openclaw.run.
      const span = runtime.spanWithDuration("openclaw.exec", spanAttrs, evt.durationMs, {
        parentContext: runtime.exportedInternalOrTrustedContext(evt, metadata),
        endTimeMs: evt.ts,
      });
      if (evt.outcome === "failed") {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          ...(evt.failureKind ? { message: evt.failureKind } : {}),
        });
      }
      span.end(evt.ts);
    },
    recordHeartbeat(evt: Extract<DiagnosticEventPayload, { type: "diagnostic.heartbeat" }>) {
      runtime.queueDepthHistogram.record(evt.queued, { "openclaw.channel": "heartbeat" });
    },
    recordLivenessWarning(
      evt: Extract<DiagnosticEventPayload, { type: "diagnostic.liveness.warning" }>,
    ) {
      const reason = evt.reasons.join(":");
      const attrs = {
        "openclaw.liveness.reason": normalizeDiagnosticValue(reason, "unknown"),
      };
      runtime.livenessWarningCounter.add(1, attrs);
      runtime.queueDepthHistogram.record(evt.queued, { "openclaw.channel": "liveness" });
      for (const [histogram, value] of [
        [runtime.livenessEventLoopDelayP99Histogram, evt.eventLoopDelayP99Ms],
        [runtime.livenessEventLoopDelayMaxHistogram, evt.eventLoopDelayMaxMs],
        [runtime.livenessEventLoopUtilizationHistogram, evt.eventLoopUtilization],
        [runtime.livenessCpuCoreRatioHistogram, evt.cpuCoreRatio],
      ] as const) {
        if (value !== undefined) {
          histogram.record(value, attrs);
        }
      }
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number> = {
        ...attrs,
        "openclaw.liveness.active": evt.active,
        "openclaw.liveness.waiting": evt.waiting,
        "openclaw.liveness.queued": evt.queued,
        "openclaw.liveness.interval_ms": evt.intervalMs,
      };
      assignOptionalNumberAttrs(spanAttrs, "openclaw.liveness.", {
        event_loop_delay_p99_ms: evt.eventLoopDelayP99Ms,
        event_loop_delay_max_ms: evt.eventLoopDelayMaxMs,
        event_loop_utilization: evt.eventLoopUtilization,
        cpu_user_ms: evt.cpuUserMs,
        cpu_system_ms: evt.cpuSystemMs,
        cpu_total_ms: evt.cpuTotalMs,
        cpu_core_ratio: evt.cpuCoreRatio,
      });
      const span = runtime.spanWithDuration("openclaw.liveness.warning", spanAttrs, 0, {
        endTimeMs: evt.ts,
      });
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: reason,
      });
      span.end(evt.ts);
    },
    recordDiagnosticPhaseCompleted(
      evt: Extract<DiagnosticEventPayload, { type: "diagnostic.phase.completed" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number> = {
        "openclaw.phase": normalizeDiagnosticValue(evt.name, "unknown"),
      };
      assignOptionalNumberAttrs(spanAttrs, "openclaw.phase.", {
        cpu_user_ms: evt.cpuUserMs,
        cpu_system_ms: evt.cpuSystemMs,
        cpu_total_ms: evt.cpuTotalMs,
        cpu_core_ratio: evt.cpuCoreRatio,
      });
      for (const [key, value] of Object.entries(evt.details ?? {})) {
        spanAttrs[`openclaw.phase.detail.${key}`] =
          typeof value === "boolean" ? String(value) : value;
      }
      const span = runtime.spanWithDuration(
        "openclaw.diagnostic.phase",
        spanAttrs,
        evt.durationMs,
        {
          endTimeMs: evt.ts,
          ...(metadata.trusted
            ? {
                parentContext:
                  runtime.internalOrTrustedExplicitParentContext(evt, metadata) ?? ROOT_CONTEXT,
              }
            : {}),
        },
      );
      span.end(evt.ts);
    },
    recordTelemetryExporter(
      evt: TelemetryExporterDiagnosticEvent,
      metadata: DiagnosticEventMetadata,
    ) {
      if (!metadata.trusted) {
        return;
      }
      runtime.telemetryExporterCounter.add(1, {
        "openclaw.exporter": normalizeDiagnosticValue(evt.exporter, "unknown"),
        "openclaw.signal": evt.signal,
        "openclaw.status": evt.status,
        ...(evt.reason ? { "openclaw.reason": evt.reason } : {}),
        ...(evt.errorCategory
          ? { "openclaw.errorCategory": normalizeDiagnosticValue(evt.errorCategory, "other") }
          : {}),
      });
    },
  };
}
