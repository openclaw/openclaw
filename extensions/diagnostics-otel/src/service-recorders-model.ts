import { SpanKind, SpanStatusCode } from "@opentelemetry/api";
import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticModelCallContent,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { asPositiveFiniteNumber } from "openclaw/plugin-sdk/number-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import {
  addUpstreamRequestIdSpanEvent,
  assignGenAiModelCallAttrs,
  assignModelCallPromptStatsAttrs,
  assignPositiveNumberAttr,
  assignModelCallUsageAttrs,
  genAiOperationName,
  modelCallSpanName,
} from "./service-genai-attributes.js";
import { assignOtelModelContentAttributes } from "./service-genai-content.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { ModelCallLifecycleDiagnosticEvent } from "./service-types.js";

export function createModelRecorders(runtime: DiagnosticsRecorderRuntime) {
  return {
    recordModelCallStarted(
      evt: Extract<DiagnosticEventPayload, { type: "model.call.started" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      if (!runtime.tracesEnabled || !metadata.trusted) {
        return undefined;
      }
      const trackedSpan = runtime.getTrackedInternalOrTrustedSpan(evt, metadata);
      if (trackedSpan) {
        return trackedSpan.spanContext();
      }
      const spanAttrs: Record<string, string | number | boolean> = {
        "openclaw.provider": evt.provider,
        "openclaw.model": evt.model,
      };
      runtime.addRunAttrs(spanAttrs, evt);
      assignGenAiModelCallAttrs(spanAttrs, evt);
      if (evt.api) {
        spanAttrs["openclaw.api"] = evt.api;
      }
      if (evt.transport) {
        spanAttrs["openclaw.transport"] = evt.transport;
      }
      assignModelCallPromptStatsAttrs(spanAttrs, evt);
      return runtime
        .trackTrustedSpan(
          evt,
          metadata,
          runtime.spanWithDuration(modelCallSpanName(evt), spanAttrs, undefined, {
            kind: SpanKind.CLIENT,
            parentContext: runtime.activeTrustedParentContext(evt, metadata),
            startTimeMs: evt.ts,
          }),
        )
        .spanContext();
    },
    recordModelCallFinished(
      evt: ModelCallLifecycleDiagnosticEvent,
      metadata: DiagnosticEventMetadata,
      modelContent?: DiagnosticModelCallContent,
    ) {
      const errorType =
        evt.type === "model.call.error"
          ? normalizeDiagnosticValue(evt.errorCategory, "other")
          : undefined;
      const metricAttrs = {
        "openclaw.provider": evt.provider,
        "openclaw.model": evt.model,
        "openclaw.api": normalizeDiagnosticValue(evt.api),
        "openclaw.transport": normalizeDiagnosticValue(evt.transport),
        "openclaw.model_call.observation_unit": evt.observationUnit ?? "request",
        ...(errorType !== undefined ? { "openclaw.errorCategory": errorType } : {}),
        ...(evt.type === "model.call.error" && evt.failureKind
          ? { "openclaw.failureKind": normalizeDiagnosticValue(evt.failureKind, "other") }
          : {}),
      };
      runtime.modelCallDurationHistogram.record(evt.durationMs, metricAttrs);
      const requestPayloadBytes = asPositiveFiniteNumber(evt.requestPayloadBytes);
      if (requestPayloadBytes !== undefined) {
        runtime.modelCallRequestBytesHistogram.record(requestPayloadBytes, metricAttrs);
      }
      const responseStreamBytes = asPositiveFiniteNumber(evt.responseStreamBytes);
      if (responseStreamBytes !== undefined) {
        runtime.modelCallResponseBytesHistogram.record(responseStreamBytes, metricAttrs);
      }
      const timeToFirstByteMs = asPositiveFiniteNumber(evt.timeToFirstByteMs);
      if (timeToFirstByteMs !== undefined) {
        runtime.modelCallTimeToFirstByteHistogram.record(timeToFirstByteMs, metricAttrs);
      }
      runtime.genAiOperationDurationHistogram.record(evt.durationMs / 1000, {
        "gen_ai.operation.name": genAiOperationName(evt.api, evt.observationUnit),
        "gen_ai.provider.name": normalizeDiagnosticValue(evt.provider),
        "gen_ai.request.model": normalizeDiagnosticValue(evt.model),
        ...(errorType ? { "error.type": errorType } : {}),
      });
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = {
        "openclaw.provider": evt.provider,
        "openclaw.model": evt.model,
        ...(errorType !== undefined
          ? { "openclaw.errorCategory": errorType, "error.type": errorType }
          : {}),
      };
      runtime.addRunAttrs(spanAttrs, evt);
      if (evt.type === "model.call.error" && evt.failureKind) {
        spanAttrs["openclaw.failureKind"] = normalizeDiagnosticValue(evt.failureKind, "other");
      }
      assignGenAiModelCallAttrs(spanAttrs, evt);
      if (evt.api) {
        spanAttrs["openclaw.api"] = evt.api;
      }
      if (evt.transport) {
        spanAttrs["openclaw.transport"] = evt.transport;
      }
      for (const [key, value] of [
        ["openclaw.model_call.request_bytes", evt.requestPayloadBytes],
        ["openclaw.model_call.response_bytes", evt.responseStreamBytes],
        ["openclaw.model_call.time_to_first_byte_ms", evt.timeToFirstByteMs],
      ] as const) {
        assignPositiveNumberAttr(spanAttrs, key, value);
      }
      assignModelCallPromptStatsAttrs(spanAttrs, evt);
      assignModelCallUsageAttrs(spanAttrs, evt);
      assignOtelModelContentAttributes(spanAttrs, modelContent, runtime.captureContent);
      const span =
        runtime.takeTrackedTrustedSpan(evt, metadata) ??
        runtime.spanWithDuration(modelCallSpanName(evt), spanAttrs, evt.durationMs, {
          kind: SpanKind.CLIENT,
          parentContext: runtime.activeTrustedParentContext(evt, metadata),
          endTimeMs: evt.ts,
        });
      runtime.setSpanAttrs(span, spanAttrs);
      addUpstreamRequestIdSpanEvent(span, evt.upstreamRequestIdHash);
      if (evt.type === "model.call.error") {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: redactSensitiveText(evt.errorCategory),
        });
      }
      span.end(evt.ts);
    },
  };
}
