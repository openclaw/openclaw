import type { DiagnosticEventPayload } from "openclaw/plugin-sdk";
import {
  context,
  isSpanContextValid,
  trace,
  SpanKind,
  SpanStatusCode,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { OtelMetricInstruments } from "./otel-metrics.js";
import type { ActiveTrace, ResolvedCaptureContent, TraceHeaders } from "./otel-utils.js";
import { formatTraceparent, mapProviderName } from "./otel-utils.js";

export type AgentInfo = {
  id: string;
  name?: string;
};

export interface OtelHandlerCtx {
  tracer: Tracer;
  metrics: OtelMetricInstruments;
  captureContent: ResolvedCaptureContent;
  tracesEnabled: boolean;
  debugExports: boolean;
  logger: { info(msg: string): void };
  activeTraces: Map<string, ActiveTrace>;
  runSpans: Map<string, { span: Span; createdAt: number }>;
  inferenceSpans: Map<string, { span: Span; createdAt: number }>;
  activeInferenceSpanByRunId: Map<string, Span>;
  runProviderByRunId: Map<string, string>;
  resolveAgentInfo: (sessionKey?: string) => AgentInfo | null;
  spanWithDuration: (
    name: string,
    attributes: Record<string, string | number | string[]>,
    durationMs?: number,
    kind?: SpanKind,
    parentCtx?: ReturnType<typeof context.active>,
  ) => Span;
  safeJsonStringify: (v: unknown) => string;
  createToolSpan: (
    evt: Extract<DiagnosticEventPayload, { type: "tool.execution" }>,
    parentCtx?: ReturnType<typeof context.active>,
  ) => void;
  ensureRunSpan: (params: {
    runId?: string;
    sessionKey?: string;
    sessionId?: string;
    channel?: string;
    startTimeMs?: number;
    attributes?: Record<string, string | number | string[]>;
  }) => Span | null;
  TRACE_ATTRS: {
    SESSION_ID: string;
  };
  getTraceHeadersRegistry: () => Map<string, TraceHeaders>;
}

export function recordRunCompleted(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "run.completed" }>,
): void {
  const attrs = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.provider": evt.provider ?? "unknown",
    "openclaw.model": evt.model ?? "unknown",
  };

  const usage = evt.usage;
  if (usage.input) {
    hctx.metrics.tokensCounter.add(usage.input, { ...attrs, "openclaw.token": "input" });
  }
  if (usage.output) {
    hctx.metrics.tokensCounter.add(usage.output, { ...attrs, "openclaw.token": "output" });
  }
  if (usage.cacheRead) {
    hctx.metrics.tokensCounter.add(usage.cacheRead, { ...attrs, "openclaw.token": "cache_read" });
  }
  if (usage.cacheWrite) {
    hctx.metrics.tokensCounter.add(usage.cacheWrite, {
      ...attrs,
      "openclaw.token": "cache_write",
    });
  }
  if (usage.promptTokens) {
    hctx.metrics.tokensCounter.add(usage.promptTokens, { ...attrs, "openclaw.token": "prompt" });
  }
  if (usage.total) {
    hctx.metrics.tokensCounter.add(usage.total, { ...attrs, "openclaw.token": "total" });
  }

  if (evt.costUsd) {
    hctx.metrics.costCounter.add(evt.costUsd, attrs);
  }
  if (evt.durationMs) {
    hctx.metrics.durationHistogram.record(evt.durationMs, attrs);
  }
  if (evt.context?.limit) {
    hctx.metrics.contextHistogram.record(evt.context.limit, {
      ...attrs,
      "openclaw.context": "limit",
    });
  }
  if (evt.context?.used) {
    hctx.metrics.contextHistogram.record(evt.context.used, {
      ...attrs,
      "openclaw.context": "used",
    });
  }

  if (!hctx.tracesEnabled) {
    return;
  }

  // Only put lightweight envelope attributes on the agent.turn span.
  // gen_ai.* inference attributes (model, messages, tokens, etc.) belong
  // exclusively on the child chat spans created by recordModelInference.
  const turnAttrs: Record<string, string | number | string[]> = {
    ...attrs,
    "openclaw.runId": evt.runId,
    "openclaw.sessionKey": evt.sessionKey ?? "",
    "openclaw.sessionId": evt.sessionId ?? "",
    "gen_ai.provider.name": mapProviderName(evt.provider),
  };
  if (typeof usage.input === "number") {
    turnAttrs["openclaw.tokens.input"] = usage.input;
  }
  if (typeof usage.output === "number") {
    turnAttrs["openclaw.tokens.output"] = usage.output;
  }
  if (typeof usage.cacheRead === "number") {
    turnAttrs["openclaw.tokens.cache_read"] = usage.cacheRead;
  }
  if (typeof usage.cacheWrite === "number") {
    turnAttrs["openclaw.tokens.cache_write"] = usage.cacheWrite;
  }
  if (typeof usage.total === "number") {
    turnAttrs["openclaw.tokens.total"] = usage.total;
  }
  if (evt.sessionId) {
    turnAttrs["gen_ai.conversation.id"] = evt.sessionId;
  }
  const runSpan = hctx.ensureRunSpan({
    runId: evt.runId,
    sessionKey: evt.sessionKey,
    sessionId: evt.sessionId,
    channel: evt.channel,
    attributes: turnAttrs,
    startTimeMs:
      typeof evt.durationMs === "number" ? Date.now() - Math.max(0, evt.durationMs) : undefined,
  });
  if (!runSpan) {
    // Fallback: add agent identity attrs for the standalone span
    const agentInfo = hctx.resolveAgentInfo(evt.sessionKey);
    if (agentInfo) {
      turnAttrs["gen_ai.agent.id"] = agentInfo.id;
      if (agentInfo.name) {
        turnAttrs["gen_ai.agent.name"] = agentInfo.name;
      }
    }
    turnAttrs["gen_ai.operation.name"] = "invoke_agent";
  }
  const fallbackSpanName = (() => {
    const agentInfo = hctx.resolveAgentInfo(evt.sessionKey);
    return agentInfo?.name ? `invoke_agent ${agentInfo.name}` : "invoke_agent";
  })();
  const finalRunSpan =
    runSpan ??
    hctx.spanWithDuration(fallbackSpanName, turnAttrs, evt.durationMs, SpanKind.INTERNAL);

  if (evt.error) {
    finalRunSpan.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
    if (evt.errorType) {
      finalRunSpan.setAttribute("error.type", evt.errorType);
    }
    finalRunSpan.setAttribute("openclaw.error", evt.error);
  }

  finalRunSpan.end();
  hctx.runSpans.delete(evt.runId);
  hctx.runProviderByRunId.delete(evt.runId);
  if (evt.sessionKey) {
    hctx.getTraceHeadersRegistry().delete(evt.sessionKey);
  }
}

export function recordRunStarted(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "run.started" }>,
): void {
  if (!hctx.tracesEnabled) {
    return;
  }
  hctx.ensureRunSpan({
    runId: evt.runId,
    sessionKey: evt.sessionKey,
    sessionId: evt.sessionId,
    channel: evt.channel,
    startTimeMs: evt.ts,
  });
}

export function recordModelInferenceStarted(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "model.inference.started" }>,
): void {
  if (!hctx.tracesEnabled) {
    return;
  }
  const opName = evt.operationName ?? "chat";

  const runSpan = hctx.ensureRunSpan({
    runId: evt.runId,
    sessionKey: evt.sessionKey,
    sessionId: evt.sessionId,
    channel: evt.channel,
    startTimeMs: evt.ts,
  });
  const parentCtx = runSpan ? trace.setSpan(context.active(), runSpan) : context.active();

  const spanAttrs: Record<string, string | number | string[]> = {
    "gen_ai.operation.name": opName,
    "gen_ai.provider.name": mapProviderName(evt.provider),
    "gen_ai.request.model": evt.model ?? "unknown",
  };
  if (evt.sessionKey) {
    spanAttrs["openclaw.sessionKey"] = evt.sessionKey;
  }
  if (evt.sessionId) {
    spanAttrs["openclaw.sessionId"] = evt.sessionId;
    spanAttrs["gen_ai.conversation.id"] = evt.sessionId;
  }
  if (typeof evt.callIndex === "number") {
    spanAttrs["openclaw.callIndex"] = evt.callIndex;
  }
  if (typeof evt.temperature === "number") {
    spanAttrs["gen_ai.request.temperature"] = evt.temperature;
  }
  if (typeof evt.maxOutputTokens === "number") {
    spanAttrs["gen_ai.request.max_tokens"] = evt.maxOutputTokens;
  }
  if (hctx.captureContent.inputMessages && evt.inputMessages) {
    spanAttrs["gen_ai.input.messages"] = JSON.stringify(evt.inputMessages);
  }
  if (hctx.captureContent.systemInstructions && evt.systemInstructions) {
    spanAttrs["gen_ai.system_instructions"] = JSON.stringify(evt.systemInstructions);
  }
  if (hctx.captureContent.toolDefinitions && evt.toolDefinitions) {
    spanAttrs["gen_ai.tool.definitions"] = JSON.stringify(evt.toolDefinitions);
  }

  const spanName = `${opName} ${evt.model ?? "unknown"}`;
  const span = hctx.tracer.startSpan(
    spanName,
    { attributes: spanAttrs, startTime: evt.ts, kind: SpanKind.CLIENT },
    parentCtx,
  );
  if (hctx.debugExports) {
    hctx.logger.info(`diagnostics-otel: span created ${spanName}`);
  }

  if (evt.runId && typeof evt.callIndex === "number") {
    hctx.inferenceSpans.set(`${evt.runId}:${evt.callIndex}`, { span, createdAt: Date.now() });
  }
  if (evt.runId) {
    hctx.activeInferenceSpanByRunId.set(evt.runId, span);
    if (evt.provider) {
      hctx.runProviderByRunId.set(evt.runId, mapProviderName(evt.provider));
    }
  }
}

export function recordModelInference(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "model.inference" }>,
): void {
  const opName = evt.operationName ?? "chat";
  const usage = evt.usage ?? {};

  // GenAI standard metrics (gen_ai_latest_experimental)
  const genAiMetricAttrs: Record<string, string> = {
    "gen_ai.operation.name": opName,
    "gen_ai.provider.name": mapProviderName(evt.provider),
    "gen_ai.request.model": evt.model ?? "unknown",
  };
  if (evt.responseModel) {
    genAiMetricAttrs["gen_ai.response.model"] = evt.responseModel;
  }
  if (evt.durationMs) {
    hctx.metrics.genAiOperationDuration.record(evt.durationMs / 1000, genAiMetricAttrs);
  }
  if (usage.input) {
    hctx.metrics.genAiTokenUsage.record(usage.input, {
      ...genAiMetricAttrs,
      "gen_ai.token.type": "input",
    });
  }
  if (usage.output) {
    hctx.metrics.genAiTokenUsage.record(usage.output, {
      ...genAiMetricAttrs,
      "gen_ai.token.type": "output",
    });
  }
  if (typeof evt.ttftMs === "number") {
    hctx.metrics.genAiTtft.record(evt.ttftMs / 1000, genAiMetricAttrs);
  }
  if (evt.error && evt.errorType) {
    hctx.metrics.inferenceErrorCounter.add(1, {
      ...genAiMetricAttrs,
      "error.type": evt.errorType,
    });
  }

  if (!hctx.tracesEnabled) {
    return;
  }

  const spanAttrs: Record<string, string | number | string[]> = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.provider": evt.provider ?? "unknown",
    "openclaw.model": evt.model ?? "unknown",
    "openclaw.sessionKey": evt.sessionKey ?? "",
    "openclaw.sessionId": evt.sessionId ?? "",
    "gen_ai.operation.name": opName,
    "gen_ai.provider.name": mapProviderName(evt.provider),
    "gen_ai.request.model": evt.model ?? "unknown",
  };
  if (typeof usage.input === "number") {
    spanAttrs["openclaw.tokens.input"] = usage.input;
  }
  if (typeof usage.output === "number") {
    spanAttrs["openclaw.tokens.output"] = usage.output;
    spanAttrs["gen_ai.usage.output_tokens"] = usage.output;
  }
  if (typeof usage.cacheRead === "number") {
    spanAttrs["openclaw.tokens.cache_read"] = usage.cacheRead;
    spanAttrs["gen_ai.usage.cache_read.input_tokens"] = usage.cacheRead;
  }
  if (typeof usage.cacheWrite === "number") {
    spanAttrs["openclaw.tokens.cache_write"] = usage.cacheWrite;
    spanAttrs["gen_ai.usage.cache_creation.input_tokens"] = usage.cacheWrite;
  }
  if (typeof usage.total === "number") {
    spanAttrs["openclaw.tokens.total"] = usage.total;
  }
  // OTEL GenAI semconv: gen_ai.usage.input_tokens SHOULD include all input
  // tokens including cached tokens. Compute from components when promptTokens
  // is unavailable to avoid under-counting.
  const hasInputComponents =
    typeof usage.input === "number" ||
    typeof usage.cacheRead === "number" ||
    typeof usage.cacheWrite === "number";
  const inputTokensForOtel =
    usage.promptTokens ??
    (hasInputComponents
      ? (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0)
      : undefined);
  if (typeof inputTokensForOtel === "number") {
    spanAttrs["gen_ai.usage.input_tokens"] = inputTokensForOtel;
  }
  if (evt.responseModel) {
    spanAttrs["gen_ai.response.model"] = evt.responseModel;
  }
  if (evt.responseId) {
    spanAttrs["gen_ai.response.id"] = evt.responseId;
  }
  if (evt.finishReasons?.length) {
    spanAttrs["gen_ai.response.finish_reasons"] = evt.finishReasons;
  }
  if (evt.sessionId) {
    spanAttrs["gen_ai.conversation.id"] = evt.sessionId;
  }
  if (typeof evt.temperature === "number") {
    spanAttrs["gen_ai.request.temperature"] = evt.temperature;
  }
  if (typeof evt.maxOutputTokens === "number") {
    spanAttrs["gen_ai.request.max_tokens"] = evt.maxOutputTokens;
  }
  if (typeof evt.ttftMs === "number") {
    spanAttrs["gen_ai.client.time_to_first_token"] = evt.ttftMs;
  }
  if (typeof evt.callIndex === "number") {
    spanAttrs["openclaw.callIndex"] = evt.callIndex;
  }
  if (hctx.captureContent.outputMessages && evt.outputMessages) {
    spanAttrs["gen_ai.output.messages"] = JSON.stringify(evt.outputMessages);
  }
  const span =
    evt.runId && typeof evt.callIndex === "number"
      ? hctx.inferenceSpans.get(`${evt.runId}:${evt.callIndex}`)?.span
      : undefined;
  const activeSpan = evt.runId ? hctx.activeInferenceSpanByRunId.get(evt.runId) : undefined;
  const resolved = span ?? activeSpan;

  if (!hctx.tracesEnabled) {
    return;
  }

  const spanName = `${opName} ${evt.model ?? "unknown"}`;
  const runEntry = evt.runId ? hctx.runSpans.get(evt.runId) : undefined;
  const parentCtx = runEntry ? trace.setSpan(context.active(), runEntry.span) : context.active();
  const finalSpan =
    resolved ??
    hctx.spanWithDuration(spanName, spanAttrs, evt.durationMs, SpanKind.CLIENT, parentCtx);

  for (const [key, value] of Object.entries(spanAttrs)) {
    finalSpan.setAttribute(key, value);
  }
  if (hctx.captureContent.outputMessages && evt.outputMessages) {
    finalSpan.setAttribute("gen_ai.output.messages", JSON.stringify(evt.outputMessages));
  }
  if (evt.error) {
    finalSpan.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
    if (evt.errorType) {
      finalSpan.setAttribute("error.type", evt.errorType);
    }
    finalSpan.setAttribute("openclaw.error", evt.error);
  }
  finalSpan.end();

  if (evt.runId) {
    hctx.activeInferenceSpanByRunId.delete(evt.runId);
    if (typeof evt.callIndex === "number") {
      hctx.inferenceSpans.delete(`${evt.runId}:${evt.callIndex}`);
    }
  }
}

export function recordWebhookReceived(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "webhook.received" }>,
): void {
  const attrs = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.webhook": evt.updateType ?? "unknown",
  };
  hctx.metrics.webhookReceivedCounter.add(1, attrs);
}

export function recordWebhookProcessed(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "webhook.processed" }>,
): void {
  const attrs = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.webhook": evt.updateType ?? "unknown",
  };
  if (typeof evt.durationMs === "number") {
    hctx.metrics.webhookDurationHistogram.record(evt.durationMs, attrs);
  }
  if (!hctx.tracesEnabled) {
    return;
  }
  const spanAttrs: Record<string, string | number> = { ...attrs };
  if (evt.chatId !== undefined) {
    spanAttrs["openclaw.chatId"] = String(evt.chatId);
  }
  const span = hctx.spanWithDuration("openclaw.webhook.processed", spanAttrs, evt.durationMs);
  if (hctx.debugExports) {
    hctx.logger.info(`diagnostics-otel: span created openclaw.webhook.processed`);
  }
  span.end();
}

export function recordWebhookError(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "webhook.error" }>,
): void {
  const attrs = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.webhook": evt.updateType ?? "unknown",
  };
  hctx.metrics.webhookErrorCounter.add(1, attrs);
  if (!hctx.tracesEnabled) {
    return;
  }
  const spanAttrs: Record<string, string | number> = {
    ...attrs,
    "openclaw.error": evt.error,
  };
  if (evt.chatId !== undefined) {
    spanAttrs["openclaw.chatId"] = String(evt.chatId);
  }
  const span = hctx.tracer.startSpan("openclaw.webhook.error", {
    attributes: spanAttrs,
  });
  span.setStatus({ code: SpanStatusCode.ERROR, message: evt.error });
  if (hctx.debugExports) {
    hctx.logger.info(`diagnostics-otel: span created openclaw.webhook.error`);
  }
  span.end();
}

export function recordMessageQueued(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "message.queued" }>,
): void {
  const attrs = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.source": evt.source ?? "unknown",
  };
  hctx.metrics.messageQueuedCounter.add(1, attrs);
  if (typeof evt.queueDepth === "number") {
    hctx.metrics.queueDepthHistogram.record(evt.queueDepth, attrs);
  }

  // Create root span for nested trace hierarchy.
  // The message lifecycle is: message.queued → run.started → model.inference → tools → run.completed → message.processed.
  // This root span covers the entire lifecycle; agent.turn, LLM calls, and tool executions are nested as children.
  // message.processed ends this span (it does not create a new child).
  if (hctx.tracesEnabled && evt.sessionKey) {
    const agentId = evt.sessionKey.split(":")[1] || "unknown";

    const rootSpan = hctx.tracer.startSpan("openclaw.message", {
      kind: SpanKind.SERVER,
      attributes: {
        "openclaw.sessionKey": evt.sessionKey,
        "openclaw.channel": evt.channel ?? "unknown",
        "openclaw.source": evt.source ?? "unknown",
        ...(typeof evt.queueDepth === "number" ? { "openclaw.queueDepth": evt.queueDepth } : {}),
        [hctx.TRACE_ATTRS.SESSION_ID]: evt.sessionKey,
      },
    });

    const traceContext = trace.setSpan(context.active(), rootSpan);

    hctx.activeTraces.set(evt.sessionKey, {
      span: rootSpan,
      context: traceContext,
      startedAt: Date.now(),
      sessionKey: evt.sessionKey,
      channel: evt.channel,
      agentId,
    });

    // Store W3C trace headers for propagation
    const spanContext = rootSpan.spanContext();
    if (isSpanContextValid(spanContext)) {
      hctx.getTraceHeadersRegistry().set(evt.sessionKey, {
        traceparent: formatTraceparent(spanContext),
        ...(spanContext.traceState && { tracestate: spanContext.traceState.serialize() }),
      });
    }

    if (hctx.debugExports) {
      hctx.logger.info(`diagnostics-otel: created root span for session=${evt.sessionKey}`);
    }
  }
}

export function recordMessageProcessed(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "message.processed" }>,
): void {
  const attrs = {
    "openclaw.channel": evt.channel ?? "unknown",
    "openclaw.outcome": evt.outcome ?? "unknown",
  };
  hctx.metrics.messageProcessedCounter.add(1, attrs);
  if (typeof evt.durationMs === "number") {
    hctx.metrics.messageDurationHistogram.record(evt.durationMs, attrs);
  }

  // End root trace span created by message.queued.
  // No standalone span here — the root span covers the full message lifecycle.
  const sessionKey = evt.sessionKey;
  const activeTrace = sessionKey ? hctx.activeTraces.get(sessionKey) : null;
  if (activeTrace) {
    activeTrace.span.setAttribute("openclaw.outcome", evt.outcome ?? "unknown");
    if (typeof evt.durationMs === "number") {
      activeTrace.span.setAttribute("openclaw.durationMs", evt.durationMs);
    }
    if (evt.messageId != null) {
      activeTrace.span.setAttribute("openclaw.messageId", String(evt.messageId));
    }
    if (evt.outcome === "error" && evt.error) {
      activeTrace.span.setStatus({
        code: SpanStatusCode.ERROR,
        message: evt.error,
      });
    } else {
      activeTrace.span.setStatus({ code: SpanStatusCode.OK });
    }
    activeTrace.span.end();
    hctx.activeTraces.delete(sessionKey!);
    hctx.getTraceHeadersRegistry().delete(sessionKey!);
    if (hctx.debugExports) {
      hctx.logger.info(`diagnostics-otel: ended root span for session=${sessionKey}`);
    }
  } else if (hctx.debugExports) {
    hctx.logger.info(
      `diagnostics-otel: no active root trace for message.processed sessionKey=${sessionKey ?? "undefined"}`,
    );
  }
}

export function recordLaneEnqueue(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "queue.lane.enqueue" }>,
): void {
  const attrs = { "openclaw.lane": evt.lane };
  hctx.metrics.laneEnqueueCounter.add(1, attrs);
  hctx.metrics.queueDepthHistogram.record(evt.queueSize, attrs);
}

export function recordLaneDequeue(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "queue.lane.dequeue" }>,
): void {
  const attrs = { "openclaw.lane": evt.lane };
  hctx.metrics.laneDequeueCounter.add(1, attrs);
  hctx.metrics.queueDepthHistogram.record(evt.queueSize, attrs);
  if (typeof evt.waitMs === "number") {
    hctx.metrics.queueWaitHistogram.record(evt.waitMs, attrs);
  }
}

export function recordSessionState(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "session.state" }>,
): void {
  const attrs: Record<string, string> = { "openclaw.state": evt.state };
  if (evt.reason) {
    attrs["openclaw.reason"] = evt.reason;
  }
  hctx.metrics.sessionStateCounter.add(1, attrs);
}

export function recordSessionStuck(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "session.stuck" }>,
): void {
  const attrs: Record<string, string> = { "openclaw.state": evt.state };
  hctx.metrics.sessionStuckCounter.add(1, attrs);
  if (typeof evt.ageMs === "number") {
    hctx.metrics.sessionStuckAgeHistogram.record(evt.ageMs, attrs);
  }
  if (!hctx.tracesEnabled) {
    return;
  }
  const spanAttrs: Record<string, string | number> = { ...attrs };
  if (evt.sessionKey) {
    spanAttrs["openclaw.sessionKey"] = evt.sessionKey;
  }
  if (evt.sessionId) {
    spanAttrs["openclaw.sessionId"] = evt.sessionId;
  }
  spanAttrs["openclaw.queueDepth"] = evt.queueDepth ?? 0;
  spanAttrs["openclaw.ageMs"] = evt.ageMs;
  const span = hctx.tracer.startSpan("openclaw.session.stuck", { attributes: spanAttrs });
  span.setStatus({ code: SpanStatusCode.ERROR, message: "session stuck" });
  if (hctx.debugExports) {
    hctx.logger.info(`diagnostics-otel: span created openclaw.session.stuck`);
  }
  span.end();
}

export function recordRunAttempt(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "run.attempt" }>,
): void {
  hctx.metrics.runAttemptCounter.add(1, { "openclaw.attempt": evt.attempt });
}

export function recordToolExecution(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "tool.execution" }>,
): void {
  if (!hctx.tracesEnabled) {
    return;
  }

  // Nest tool span under root message.process span (via activeTraces)
  // or fallback to run/inference spans if activeTrace not found
  const activeTrace = evt.sessionKey ? hctx.activeTraces.get(evt.sessionKey) : null;
  if (activeTrace) {
    hctx.createToolSpan(evt, activeTrace.context);
    return;
  }

  // Fallback: try run/inference spans
  const runId = evt.runId;
  const inferenceSpan = runId ? hctx.activeInferenceSpanByRunId.get(runId) : undefined;
  const runEntry = runId ? hctx.runSpans.get(runId) : undefined;
  const parentSpan = inferenceSpan ?? runEntry?.span;
  const parentCtx = parentSpan ? trace.setSpan(context.active(), parentSpan) : undefined;
  hctx.createToolSpan(evt, parentCtx);

  if (hctx.debugExports && !activeTrace && !parentCtx) {
    hctx.logger.info(
      `diagnostics-otel: no active trace for tool.execution sessionKey=${evt.sessionKey} tool=${evt.toolName}`,
    );
  }
}

export function recordHeartbeat(
  hctx: OtelHandlerCtx,
  evt: Extract<DiagnosticEventPayload, { type: "diagnostic.heartbeat" }>,
): void {
  hctx.metrics.queueDepthHistogram.record(evt.queued, { "openclaw.channel": "heartbeat" });
}
