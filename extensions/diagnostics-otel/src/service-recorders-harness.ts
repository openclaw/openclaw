import { SpanStatusCode } from "@opentelemetry/api";
import {
  normalizeDiagnosticValue,
  normalizeDiagnosticLane,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { redactOtelAttributes } from "./service-attributes.js";
import {
  normalizeOtelContentValue,
  normalizeOtelErrorMessage,
} from "./service-content-normalization.js";
import { assignOtelModelContentAttributes } from "./service-genai-content.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { HarnessRunDiagnosticEvent, ModelFailoverDiagnosticEvent } from "./service-types.js";

export function createHarnessRecorders(runtime: DiagnosticsRecorderRuntime) {
  const harnessRunMetricAttrs = (evt: HarnessRunDiagnosticEvent) => ({
    "openclaw.harness.id": normalizeDiagnosticValue(evt.harnessId, "unknown"),
    "openclaw.harness.plugin": normalizeDiagnosticValue(evt.pluginId),
    ...(evt.type === "harness.run.started"
      ? {}
      : {
          "openclaw.outcome": evt.type === "harness.run.error" ? "error" : evt.outcome,
        }),
    "openclaw.provider": normalizeDiagnosticValue(evt.provider, "unknown"),
    "openclaw.model": normalizeDiagnosticValue(evt.model, "unknown"),
    ...(evt.channel ? { "openclaw.channel": normalizeDiagnosticValue(evt.channel) } : {}),
  });

  return {
    recordAgentCommentary(
      evt: Extract<DiagnosticEventPayload, { type: "agent.commentary" }>,
      metadata: DiagnosticEventMetadata,
      privateData: DiagnosticEventPrivateData,
    ) {
      if (!runtime.tracesEnabled || !metadata.trusted) {
        return;
      }
      const span = runtime.getTrackedInternalOrTrustedSpan(evt, metadata);
      if (!span) {
        return;
      }
      const attrs: Record<string, string | number | boolean> = {
        "openclaw.harness.id": normalizeDiagnosticValue(evt.harnessId, "unknown"),
        "openclaw.commentary.sequence": evt.sourceSequence,
        "openclaw.commentary.text_length": evt.textLength,
        "openclaw.commentary.content_truncated": evt.contentTruncated,
      };
      assignOtelModelContentAttributes(attrs, privateData.modelContent, runtime.captureContent);
      // addEvent bypasses setSpanAttrs; apply the same redaction and identifier
      // policy. Queued commentary precedes queued harness completion.
      span.addEvent(
        "openclaw.agent.commentary",
        redactOtelAttributes(attrs),
        evt.sourceTimestampMs,
      );
    },
    recordHarnessRunStarted(
      evt: Extract<DiagnosticEventPayload, { type: "harness.run.started" }>,
      metadata: DiagnosticEventMetadata,
      privateData: DiagnosticEventPrivateData,
    ) {
      if (!runtime.tracesEnabled || !metadata.trusted) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = {
        ...harnessRunMetricAttrs(evt),
      };
      runtime.addRunAttrs(spanAttrs, evt);
      const inputValue = runtime.captureContent
        ? normalizeOtelContentValue(privateData.harnessContent?.userPrompt)
        : undefined;
      if (inputValue) {
        spanAttrs["input.value"] = inputValue;
      }
      runtime.trackTrustedSpan(
        evt,
        metadata,
        runtime.spanWithDuration("openclaw.harness.run", spanAttrs, undefined, {
          parentContext: runtime.activeTrustedParentContext(evt, metadata),
          startTimeMs: evt.ts,
        }),
      );
    },
    recordHarnessRunFinished(
      evt: Extract<DiagnosticEventPayload, { type: "harness.run.completed" | "harness.run.error" }>,
      metadata: DiagnosticEventMetadata,
      privateData: DiagnosticEventPrivateData,
    ) {
      const errorType =
        evt.type === "harness.run.error"
          ? normalizeDiagnosticValue(evt.errorCategory, "other")
          : "error";
      const attrs = {
        ...harnessRunMetricAttrs(evt),
        ...(evt.type === "harness.run.error"
          ? { "openclaw.harness.phase": evt.phase, "openclaw.errorCategory": errorType }
          : {}),
      };
      runtime.harnessDurationHistogram.record(evt.durationMs, attrs);
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = { ...attrs };
      runtime.addRunAttrs(spanAttrs, evt);
      if (evt.type === "harness.run.completed") {
        if (evt.resultClassification) {
          spanAttrs["openclaw.harness.result_classification"] = normalizeDiagnosticValue(
            evt.resultClassification,
          );
        }
        if (typeof evt.yieldDetected === "boolean") {
          spanAttrs["openclaw.harness.yield_detected"] = evt.yieldDetected;
        }
        if (evt.itemLifecycle) {
          spanAttrs["openclaw.harness.items.started"] = evt.itemLifecycle.startedCount;
          spanAttrs["openclaw.harness.items.completed"] = evt.itemLifecycle.completedCount;
          spanAttrs["openclaw.harness.items.active"] = evt.itemLifecycle.activeCount;
        }
      } else {
        spanAttrs["error.type"] = errorType;
        if (evt.cleanupFailed) {
          spanAttrs["openclaw.harness.cleanup_failed"] = true;
        }
      }
      // Redacted message goes on the span only, never the low-cardinality metric attrs.
      const redactedError = normalizeOtelErrorMessage(privateData.errorMessage);
      if (redactedError) {
        spanAttrs["openclaw.error"] = redactedError;
      }
      // CLI harnesses attach content at completion rather than startup, so the
      // prompt must be consumable here as well; setSpanAttrs below preserves any
      // input.value already recorded on the tracked span at startup.
      const inputValue = runtime.captureContent
        ? normalizeOtelContentValue(privateData.harnessContent?.userPrompt)
        : undefined;
      if (inputValue) {
        spanAttrs["input.value"] = inputValue;
      }
      const outputValue = runtime.captureContent
        ? normalizeOtelContentValue(privateData.harnessContent?.finalResponse)
        : undefined;
      if (outputValue) {
        spanAttrs["output.value"] = outputValue;
      }
      const trustedTrace = runtime.trustedTraceContext(evt, metadata);
      const trackedSpan = trustedTrace?.spanId
        ? runtime.activeTrustedSpans.get(trustedTrace.spanId)
        : undefined;
      const span =
        trackedSpan ??
        runtime.spanWithDuration("openclaw.harness.run", spanAttrs, evt.durationMs, {
          parentContext: runtime.activeTrustedParentContext(evt, metadata),
          endTimeMs: evt.ts,
        });
      runtime.setSpanAttrs(span, spanAttrs);
      if (evt.type === "harness.run.error" || evt.outcome === "error") {
        span.setStatus({ code: SpanStatusCode.ERROR, message: redactedError ?? errorType });
      }
      // Aborted runs also retain their context for late children.
      runtime.completeTrackedLifecycleSpan(trackedSpan ? trustedTrace : undefined, span, evt.ts);
    },
    recordContextAssembled(
      evt: Extract<DiagnosticEventPayload, { type: "context.assembled" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = {
        "openclaw.context.message_count": evt.messageCount,
        "openclaw.context.history_text_chars": evt.historyTextChars,
        "openclaw.context.history_image_blocks": evt.historyImageBlocks,
        "openclaw.context.max_message_text_chars": evt.maxMessageTextChars,
        "openclaw.context.system_prompt_chars": evt.systemPromptChars,
        "openclaw.context.prompt_chars": evt.promptChars,
        "openclaw.context.prompt_images": evt.promptImages,
      };
      runtime.addRunAttrs(spanAttrs, evt);
      if (evt.contextTokenBudget !== undefined) {
        spanAttrs["openclaw.context.token_budget"] = evt.contextTokenBudget;
      }
      if (evt.reserveTokens !== undefined) {
        spanAttrs["openclaw.context.reserve_tokens"] = evt.reserveTokens;
      }
      const span = runtime.spanWithDuration("openclaw.context.assembled", spanAttrs, 0, {
        parentContext: runtime.activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
      span.end(evt.ts);
    },
    recordModelFailover(evt: ModelFailoverDiagnosticEvent, metadata: DiagnosticEventMetadata) {
      const metricAttrs: Record<string, string> = {
        "openclaw.failover.reason": normalizeDiagnosticValue(evt.reason, "unknown"),
        "openclaw.failover.suspended":
          evt.suspended === undefined ? "unknown" : String(evt.suspended),
        "openclaw.lane": normalizeDiagnosticLane(evt.lane, "unknown"),
        "openclaw.model": normalizeDiagnosticValue(evt.fromModel),
        "openclaw.provider": normalizeDiagnosticValue(evt.fromProvider),
        "openclaw.failover.to_model": normalizeDiagnosticValue(evt.toModel),
        "openclaw.failover.to_provider": normalizeDiagnosticValue(evt.toProvider),
      };
      runtime.modelFailoverCounter.add(1, metricAttrs);
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = {
        "openclaw.failover.reason": normalizeDiagnosticValue(evt.reason, "unknown"),
      };
      if (evt.fromProvider) {
        spanAttrs["openclaw.provider"] = evt.fromProvider;
      }
      if (evt.fromModel) {
        spanAttrs["openclaw.model"] = evt.fromModel;
      }
      if (evt.toProvider) {
        spanAttrs["openclaw.failover.to_provider"] = evt.toProvider;
      }
      if (evt.toModel) {
        spanAttrs["openclaw.failover.to_model"] = evt.toModel;
      }
      if (evt.lane) {
        spanAttrs["openclaw.lane"] = normalizeDiagnosticLane(evt.lane, "unknown");
      }
      if (evt.suspended !== undefined) {
        spanAttrs["openclaw.failover.suspended"] = evt.suspended;
      }
      if (evt.cascadeDepth !== undefined) {
        spanAttrs["openclaw.failover.cascade_depth"] = evt.cascadeDepth;
      }
      const span = runtime.spanWithDuration("openclaw.model.failover", spanAttrs, 0, {
        parentContext: runtime.activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
      span.end(evt.ts);
    },
  };
}
