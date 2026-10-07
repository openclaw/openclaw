import { SpanStatusCode } from "@opentelemetry/api";
import { normalizeDiagnosticValue } from "openclaw/plugin-sdk/diagnostic-runtime";
import type {
  DiagnosticEventMetadata,
  DiagnosticEventPayload,
  DiagnosticEventPrivateData,
} from "openclaw/plugin-sdk/diagnostic-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/security-runtime";
import { normalizeOtelContentValue } from "./service-content-normalization.js";
import {
  assignGenAiSpanIdentityAttrs,
  assignPositiveNumberAttr,
} from "./service-genai-attributes.js";
import type { DiagnosticsRecorderRuntime } from "./service-recorder-runtime.js";
import type { MessageDeliveryDiagnosticEvent, TrustedSpanAliasOwner } from "./service-types.js";

export function createUsageRecorders(runtime: DiagnosticsRecorderRuntime) {
  const messageDeliveryAttrs = (evt: MessageDeliveryDiagnosticEvent): Record<string, string> => ({
    "openclaw.channel": normalizeDiagnosticValue(evt.channel),
    "openclaw.delivery.kind": normalizeDiagnosticValue(evt.deliveryKind, "other"),
  });

  return {
    recordModelUsage(
      evt: Extract<DiagnosticEventPayload, { type: "model.usage" }>,
      metadata: DiagnosticEventMetadata,
      hostPluginId?: string,
    ) {
      const attrs = {
        "openclaw.channel": evt.channel ?? "unknown",
        "openclaw.agent": normalizeDiagnosticValue(evt.agentId),
        "openclaw.provider": evt.provider ?? "unknown",
        "openclaw.model": evt.model ?? "unknown",
      };
      const genAiAttrs: Record<string, string> = {
        "gen_ai.operation.name": "chat",
        "gen_ai.provider.name": normalizeDiagnosticValue(evt.provider),
        "gen_ai.request.model": normalizeDiagnosticValue(evt.model),
      };

      const usage = evt.usage;
      for (const [tokenType, field] of [
        ["input", "input"],
        ["output", "output"],
        ["cache_read", "cacheRead"],
        ["cache_write", "cacheWrite"],
        ["prompt", "promptTokens"],
        ["total", "total"],
      ] as const) {
        const amount = usage[field];
        if (!amount) {
          continue;
        }
        runtime.tokensCounter.add(amount, { ...attrs, "openclaw.token": tokenType });
        if (tokenType === "input" || tokenType === "output") {
          runtime.genAiTokenUsageHistogram.record(amount, {
            ...genAiAttrs,
            "gen_ai.token.type": tokenType,
          });
        }
      }

      if (evt.costUsd) {
        runtime.costCounter.add(evt.costUsd, attrs);
      }
      if (evt.durationMs) {
        runtime.durationHistogram.record(evt.durationMs, attrs);
      }
      for (const kind of ["limit", "used"] as const) {
        const amount = evt.context?.[kind];
        if (amount) {
          runtime.contextHistogram.record(amount, { ...attrs, "openclaw.context": kind });
        }
      }

      if (!runtime.tracesEnabled) {
        return;
      }
      const genAiInputTokens =
        usage.promptTokens ?? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
      const spanAttrs: Record<string, string | number> = {
        ...attrs,
        "openclaw.tokens.input": usage.input ?? 0,
        "openclaw.tokens.output": usage.output ?? 0,
        "openclaw.tokens.cache_read": usage.cacheRead ?? 0,
        "openclaw.tokens.cache_write": usage.cacheWrite ?? 0,
        "openclaw.tokens.total": usage.total ?? 0,
      };
      if (metadata.trusted && metadata.internal && hostPluginId) {
        spanAttrs["openclaw.plugin"] = normalizeDiagnosticValue(hostPluginId);
      }
      assignGenAiSpanIdentityAttrs(spanAttrs, evt);
      runtime.addRunAttrs(spanAttrs, evt);
      assignPositiveNumberAttr(spanAttrs, "gen_ai.usage.input_tokens", genAiInputTokens);
      assignPositiveNumberAttr(spanAttrs, "gen_ai.usage.output_tokens", usage.output);
      assignPositiveNumberAttr(spanAttrs, "gen_ai.usage.cache_read.input_tokens", usage.cacheRead);
      assignPositiveNumberAttr(
        spanAttrs,
        "gen_ai.usage.cache_creation.input_tokens",
        usage.cacheWrite,
      );

      const span = runtime.spanWithDuration("openclaw.model.usage", spanAttrs, evt.durationMs, {
        parentContext: runtime.activeTrustedParentContext(evt, metadata),
        endTimeMs: evt.ts,
      });
      span.end(evt.ts);
    },
    recordWebhookReceived(evt: Extract<DiagnosticEventPayload, { type: "webhook.received" }>) {
      const attrs = {
        "openclaw.channel": evt.channel ?? "unknown",
        "openclaw.webhook": evt.updateType ?? "unknown",
      };
      runtime.webhookReceivedCounter.add(1, attrs);
    },
    recordWebhookProcessed(evt: Extract<DiagnosticEventPayload, { type: "webhook.processed" }>) {
      const attrs = {
        "openclaw.channel": normalizeDiagnosticValue(evt.channel),
        "openclaw.webhook": normalizeDiagnosticValue(evt.updateType),
      };
      if (typeof evt.durationMs === "number") {
        runtime.webhookDurationHistogram.record(evt.durationMs, attrs);
      }
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number> = { ...attrs };
      const span = runtime.spanWithDuration(
        "openclaw.webhook.processed",
        spanAttrs,
        evt.durationMs,
      );
      span.end();
    },
    recordWebhookError(evt: Extract<DiagnosticEventPayload, { type: "webhook.error" }>) {
      const attrs = {
        "openclaw.channel": normalizeDiagnosticValue(evt.channel),
        "openclaw.webhook": normalizeDiagnosticValue(evt.updateType),
      };
      runtime.webhookErrorCounter.add(1, attrs);
      if (!runtime.tracesEnabled) {
        return;
      }
      const redactedError = redactSensitiveText(evt.error);
      const spanAttrs: Record<string, string | number> = {
        ...attrs,
        "openclaw.error": redactedError,
      };
      const span = runtime.tracer.startSpan("openclaw.webhook.error", {
        attributes: spanAttrs,
      });
      span.setStatus({ code: SpanStatusCode.ERROR, message: redactedError });
      span.end();
    },
    recordMessageQueued(evt: Extract<DiagnosticEventPayload, { type: "message.queued" }>) {
      const attrs = {
        "openclaw.channel": normalizeDiagnosticValue(evt.channel),
        "openclaw.source": normalizeDiagnosticValue(evt.source),
      };
      runtime.messageQueuedCounter.add(1, attrs);
      if (typeof evt.queueDepth === "number") {
        runtime.queueDepthHistogram.record(evt.queueDepth, attrs);
      }
    },
    recordMessageReceived(evt: Extract<DiagnosticEventPayload, { type: "message.received" }>) {
      runtime.messageReceivedCounter.add(1, {
        "openclaw.channel": normalizeDiagnosticValue(evt.channel),
        "openclaw.source": normalizeDiagnosticValue(evt.source),
      });
    },
    recordMessageDispatchStarted(
      evt: Extract<DiagnosticEventPayload, { type: "message.dispatch.started" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      const attrs = {
        "openclaw.channel": normalizeDiagnosticValue(evt.channel),
        "openclaw.source": normalizeDiagnosticValue(evt.source),
      };
      runtime.messageDispatchStartedCounter.add(1, attrs);
      if (!runtime.tracesEnabled) {
        return;
      }
      const traceContext = runtime.internalOrTrustedTraceContext(evt, metadata);
      if (!traceContext?.spanId || runtime.activeTrustedSpans.has(traceContext.spanId)) {
        return;
      }
      runtime.trackInternalOrTrustedSpan(
        evt,
        metadata,
        runtime.spanWithDuration("openclaw.message.processed", attrs, undefined, {
          parentContext: runtime.internalOrTrustedExplicitParentContext(evt, metadata),
          startTimeMs: evt.ts,
        }),
      );
    },
    recordMessageDispatchCompleted(
      evt: Extract<DiagnosticEventPayload, { type: "message.dispatch.completed" }>,
    ) {
      const attrs = {
        "openclaw.channel": normalizeDiagnosticValue(evt.channel),
        "openclaw.outcome": evt.outcome,
        "openclaw.reason": normalizeDiagnosticValue(evt.reason, "none"),
        "openclaw.source": normalizeDiagnosticValue(evt.source),
      };
      runtime.messageDispatchCompletedCounter.add(1, attrs);
      runtime.messageDispatchDurationHistogram.record(evt.durationMs, attrs);
    },
    recordMessageProcessed(
      evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
      metadata: DiagnosticEventMetadata,
      privateData: DiagnosticEventPrivateData,
    ) {
      const attrs = {
        "openclaw.channel": normalizeDiagnosticValue(evt.channel),
        "openclaw.outcome": evt.outcome ?? "unknown",
      };
      runtime.messageProcessedCounter.add(1, attrs);
      if (typeof evt.durationMs === "number") {
        runtime.messageDurationHistogram.record(evt.durationMs, attrs);
      }
      if (!runtime.tracesEnabled) {
        return;
      }
      const spanAttrs: Record<string, string | number> = { ...attrs };
      runtime.addRunAttrs(spanAttrs, evt);
      if (evt.reason) {
        spanAttrs["openclaw.reason"] = normalizeDiagnosticValue(evt.reason, "unknown");
      }
      const inputValue = runtime.captureContent
        ? normalizeOtelContentValue(privateData.messageContent?.userPrompt)
        : undefined;
      if (inputValue) {
        spanAttrs["input.value"] = inputValue;
      }
      const outputValue = runtime.captureContent
        ? normalizeOtelContentValue(privateData.messageContent?.finalResponse)
        : undefined;
      if (outputValue) {
        spanAttrs["output.value"] = outputValue;
      }
      const trackedSpan = runtime.getTrackedInternalOrTrustedSpan(evt, metadata);
      const span =
        trackedSpan ??
        runtime.spanWithDuration("openclaw.message.processed", spanAttrs, evt.durationMs, {
          parentContext: runtime.internalOrTrustedExplicitParentContext(evt, metadata),
          endTimeMs: evt.ts,
        });
      runtime.setSpanAttrs(span, spanAttrs);
      if (evt.outcome === "error" && evt.error) {
        span.setStatus({ code: SpanStatusCode.ERROR, message: redactSensitiveText(evt.error) });
      }
      const traceContext = runtime.internalOrTrustedTraceContext(evt, metadata);
      runtime.completeTrackedLifecycleSpan(trackedSpan ? traceContext : undefined, span, evt.ts);
    },
    recordMessageDeliveryStarted(
      evt: Extract<DiagnosticEventPayload, { type: "message.delivery.started" }>,
    ) {
      runtime.messageDeliveryStartedCounter.add(1, messageDeliveryAttrs(evt));
    },
    recordMessageDeliveryFinished(
      evt: Extract<
        DiagnosticEventPayload,
        { type: "message.delivery.completed" | "message.delivery.error" }
      >,
      metadata: DiagnosticEventMetadata,
    ) {
      const attrs = {
        ...messageDeliveryAttrs(evt),
        "openclaw.outcome": evt.type === "message.delivery.error" ? "error" : "completed",
        ...(evt.type === "message.delivery.error"
          ? { "openclaw.errorCategory": normalizeDiagnosticValue(evt.errorCategory, "other") }
          : {}),
      };
      runtime.messageDeliveryDurationHistogram.record(evt.durationMs, attrs);
      if (!runtime.tracesEnabled) {
        return;
      }
      const span = runtime.spanWithDuration(
        "openclaw.message.delivery",
        {
          ...attrs,
          ...(evt.type === "message.delivery.completed"
            ? { "openclaw.delivery.result_count": evt.resultCount }
            : {}),
        },
        evt.durationMs,
        { parentContext: runtime.activeInternalOrTrustedContext(evt, metadata), endTimeMs: evt.ts },
      );
      if (evt.type === "message.delivery.error") {
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: redactSensitiveText(evt.errorCategory),
        });
      }
      span.end(evt.ts);
    },
    recordRunStarted(
      evt: Extract<DiagnosticEventPayload, { type: "run.started" }>,
      metadata: DiagnosticEventMetadata,
    ) {
      if (!runtime.tracesEnabled || !metadata.trusted) {
        return;
      }
      const spanAttrs: Record<string, string | number | boolean> = {};
      runtime.addRunAttrs(spanAttrs, evt);
      const span = runtime.trackTrustedSpan(
        evt,
        metadata,
        runtime.spanWithDuration("openclaw.run", spanAttrs, undefined, {
          parentContext: runtime.activeTrustedParentContext(evt, metadata),
          startTimeMs: evt.ts,
        }),
      );
      const parentSpanId = runtime.trustedTraceContext(evt, metadata)?.parentSpanId;
      if (parentSpanId && !runtime.activeTrustedSpans.has(parentSpanId)) {
        const owner: TrustedSpanAliasOwner = { kind: "run", id: evt.runId };
        runtime.activeTrustedSpanAliases.set(runtime.trustedSpanAliasKey(parentSpanId, owner), {
          span,
          spanId: parentSpanId,
          owner,
        });
      }
    },
  };
}
