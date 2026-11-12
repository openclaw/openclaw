import {
  markModelPayloadObserver,
  modelRequestBodyState,
} from "@openclaw/ai/internal/model-request-body";
import { withProviderAcceptanceObserver } from "@openclaw/ai/transports";
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { fireAndForgetBoundedHook } from "../../../hooks/fire-and-forget.js";
import { emitAgentEvent } from "../../../infra/agent-events.js";
import { getAgentRunContext } from "../../../infra/agent-run-registry.js";
import {
  diagnosticErrorCategory,
  diagnosticErrorFailureKind,
  diagnosticHttpStatusCode,
  diagnosticProviderRequestIdHash,
} from "../../../infra/diagnostic-error-metadata.js";
import {
  hasInternalDiagnosticEventInterest,
  hasModelCallPromptStatsInterest,
} from "../../../infra/diagnostic-event-listener-presence.js";
import {
  areDiagnosticsEnabledForProcess,
  type DiagnosticEventInput,
  type DiagnosticModelCallContent,
  type DiagnosticMemoryUsage,
} from "../../../infra/diagnostic-events.js";
import type { DiagnosticModelContentCapturePolicy } from "../../../infra/diagnostic-llm-content.js";
import type { CoreModelRequestOwnerGeneration } from "../../../infra/diagnostic-model-request-provenance.js";
import {
  emitCoreModelRequestEndedDiagnosticEvent,
  emitCoreModelRequestStartedDiagnosticEvent,
} from "../../../infra/diagnostic-model-request.js";
import {
  createChildDiagnosticTraceContext,
  freezeDiagnosticTraceContext,
  type DiagnosticTraceContext,
} from "../../../infra/diagnostic-trace-context.js";
import {
  formatPropagatedDiagnosticTraceparent,
  hasDiagnosticTracePropagationConsumer,
} from "../../../infra/diagnostic-trace-propagation.js";
import {
  emitDiagnosticsTimelineEvent,
  modelUsageTimelineAttributes,
} from "../../../infra/diagnostics-timeline.js";
import { withModelTransportContext } from "../../../llm/model-transport-context.js";
import type { ModelRequestHeaders } from "../../../llm/types.js";
import { createModelCallStreamProgressReporter } from "../../../logging/diagnostic-model-stream-progress.js";
import type { DiagnosticEmbeddedRunOwner } from "../../../logging/diagnostic-run-activity.js";
import { recordReasoningSuppressedDiagnostic } from "../../../logging/diagnostic-session-state.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import type {
  PluginHookAgentContext,
  PluginHookModelCallEndedEvent,
  PluginHookModelCallStartedEvent,
} from "../../../plugins/hook-types.js";
import { captureAsyncWorkTracker } from "../../../shared/async-work-scope.js";
import type { EmbeddedAgentEvent } from "../../embedded-agent-subscribe.shared-types.js";
import type { StreamFn } from "../../runtime/index.js";
import { log } from "../logger.js";
import type {
  createModelObserver,
  ModelCallEventBase,
} from "./attempt.model-diagnostic-observation.js";

export type ModelCallDiagnosticContext = Omit<PluginHookModelCallStartedEvent, "callId"> & {
  config?: OpenClawConfig;
  agentId?: string;
  trace: DiagnosticTraceContext;
  contentCapture?: DiagnosticModelContentCapturePolicy;
  nextCallId: () => string;
  ownerGeneration?: CoreModelRequestOwnerGeneration;
  diagnosticOwner?: DiagnosticEmbeddedRunOwner;
  onStarted?: (callId: string) => void;
  /** Request observation ended; cleanup settlement and replay admission remain separately owned. */
  onFinished?: (callId: string) => void;
  /** Each streamed non-empty text, thinking or tool-call delta; keepalives never count. */
  onOutputDelta?: () => void;
  onTerminal?: () => void;
  onSucceeded?: (startedAt: number) => void;
  onAgentEvent?: (event: EmbeddedAgentEvent) => void | Promise<void>;
  suppressPluginHooks?: boolean;
  requestTimeoutMs?: number;
  priority?: "interactive" | "background";
};

type ModelCallErrorFields = Pick<
  Extract<DiagnosticEventInput, { type: "model.call.error" }>,
  "errorCategory" | "failureKind" | "memory" | "upstreamRequestIdHash"
>;
type ModelCallEndedHookFields = Omit<
  PluginHookModelCallEndedEvent,
  keyof PluginHookModelCallStartedEvent
>;
type ModelCallObserver = ReturnType<typeof createModelObserver>;

const TRACEPARENT_HEADER_NAME = "traceparent";
const TIMELINE_ATTRIBUTE_MAX_LENGTH = 256;
type ModelCallStreamOptions = Parameters<StreamFn>[2];

function modelContentPrivateData(modelContent: DiagnosticModelCallContent | undefined) {
  return modelContent ? { modelContent } : undefined;
}

function isModelOutputDelta(chunk: unknown): boolean {
  return (
    isRecord(chunk) &&
    (chunk.type === "text_delta" ||
      chunk.type === "thinking_delta" ||
      chunk.type === "toolcall_delta") &&
    typeof chunk.delta === "string" &&
    chunk.delta.length > 0
  );
}

function boundedTimelineAttribute(value: string | undefined): string | undefined {
  return truncateUtf16Safe(value?.trim() ?? "", TIMELINE_ATTRIBUTE_MAX_LENGTH) || undefined;
}

function modelCallErrorFields(err: unknown): ModelCallErrorFields {
  const upstreamRequestIdHash = diagnosticProviderRequestIdHash(err);
  const failureKind = diagnosticErrorFailureKind(err);
  return {
    errorCategory: diagnosticErrorCategory(err),
    ...(failureKind ? { failureKind, memory: processMemoryUsageSnapshot() } : {}),
    ...(upstreamRequestIdHash ? { upstreamRequestIdHash } : {}),
  };
}

function processMemoryUsageSnapshot(): DiagnosticMemoryUsage | undefined {
  try {
    const memory = process.memoryUsage();
    return {
      rssBytes: memory.rss,
      heapTotalBytes: memory.heapTotal,
      heapUsedBytes: memory.heapUsed,
      externalBytes: memory.external,
      arrayBuffersBytes: memory.arrayBuffers,
    };
  } catch {
    return undefined;
  }
}

const modelCallContextBudget = (eventBase: PluginHookModelCallStartedEvent) => ({
  ...(eventBase.contextTokenBudget ? { contextTokenBudget: eventBase.contextTokenBudget } : {}),
  ...(eventBase.contextWindowSource ? { contextWindowSource: eventBase.contextWindowSource } : {}),
  ...(eventBase.contextWindowReferenceTokens
    ? { contextWindowReferenceTokens: eventBase.contextWindowReferenceTokens }
    : {}),
});

function modelCallHookEventBase(
  eventBase: PluginHookModelCallStartedEvent,
): PluginHookModelCallStartedEvent {
  return {
    runId: eventBase.runId,
    callId: eventBase.callId,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    provider: eventBase.provider,
    model: eventBase.model,
    ...(eventBase.api ? { api: eventBase.api } : {}),
    ...(eventBase.transport ? { transport: eventBase.transport } : {}),
    ...modelCallContextBudget(eventBase),
  };
}

function dispatchModelCallHook(
  eventBase: ModelCallEventBase,
  fields?: ModelCallEndedHookFields,
): void {
  const hookRunner = getGlobalHookRunner();
  const hookName = fields ? "model_call_ended" : "model_call_started";
  if (!hookRunner?.hasHooks(hookName)) {
    return;
  }
  const event = Object.freeze(modelCallHookEventBase(eventBase));
  const hookCtx: PluginHookAgentContext = Object.freeze({
    runId: eventBase.runId,
    ...(eventBase.agentId ? { agentId: eventBase.agentId } : {}),
    trace: eventBase.trace,
    ...(eventBase.sessionKey ? { sessionKey: eventBase.sessionKey } : {}),
    ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
    modelProviderId: eventBase.provider,
    modelId: eventBase.model,
    ...modelCallContextBudget(eventBase),
  });
  fireAndForgetBoundedHook(
    () =>
      fields
        ? hookRunner.runModelCallEnded(Object.freeze({ ...event, ...fields }), hookCtx)
        : hookRunner.runModelCallStarted(event, hookCtx),
    `${hookName} plugin hook failed`,
  );
}

export function createModelLifecycle(params: {
  ctx: ModelCallDiagnosticContext;
  options: ModelCallStreamOptions;
  requestTimeoutMs?: number;
  createObserver: (capturePromptStats: boolean, captureByteStats: boolean) => ModelCallObserver;
}) {
  const callId = params.ctx.nextCallId();
  const runContext = getAgentRunContext(params.ctx.runId);
  const transportContext: Parameters<typeof withModelTransportContext>[0] = {
    sessionKey: params.ctx.sessionKey,
    runId: params.ctx.runId,
    requestId: callId,
    priority: params.ctx.priority,
    onRateLimitWait: (retryAt: number) => {
      const delayMs = Math.max(0, retryAt - Date.now());
      reportStatus({
        phase: "retrying",
        reason: "rate_limit",
        message: `Waiting for rate limit. Retrying in ${Math.ceil(delayMs / 1000)}s.`,
        delayMs,
        retryAt,
      });
      return () => reportStatus({ phase: "starting_model" });
    },
  };
  const trace = freezeDiagnosticTraceContext(createChildDiagnosticTraceContext(params.ctx.trace));
  const observer = params.createObserver(
    areDiagnosticsEnabledForProcess() && hasModelCallPromptStatsInterest(),
    (areDiagnosticsEnabledForProcess() &&
      (hasInternalDiagnosticEventInterest("model.call.completed", true) ||
        hasInternalDiagnosticEventInterest("model.call.error", true) ||
        hasDiagnosticTracePropagationConsumer())) ||
      (params.ctx.suppressPluginHooks !== true &&
        getGlobalHookRunner()?.hasHooks("model_call_ended") === true),
  );
  const eventBase: ModelCallEventBase = {
    ...modelCallHookEventBase({ ...params.ctx, callId }),
    ...(params.ctx.agentId ? { agentId: params.ctx.agentId } : {}),
    observationUnit: "request",
    ...(observer.promptStats ? { promptStats: observer.promptStats } : {}),
    trace,
  };
  const watchdogAttempt = params.ctx.diagnosticOwner?.watchdogAttempt;
  const reportStreamProgress = createModelCallStreamProgressReporter({
    config: params.ctx.config,
    target: eventBase,
    recordProgress: watchdogAttempt
      ? () => watchdogAttempt.progress("transport", "model_call:stream_progress")
      : undefined,
  });
  emitCoreModelRequestStartedDiagnosticEvent(
    eventBase,
    params.ctx.ownerGeneration,
    params.requestTimeoutMs,
    modelContentPrivateData(observer.modelContent),
  );
  if (params.ctx.suppressPluginHooks !== true) {
    dispatchModelCallHook(eventBase);
  }
  const startedAt = Date.now();
  emitDiagnosticsTimelineEvent(
    {
      type: "mark",
      name: "provider.request.started",
      timestamp: new Date(startedAt).toISOString(),
      runId: eventBase.runId,
      spanId: callId,
      provider: eventBase.provider,
      attributes: {
        model: eventBase.model,
        observationUnit: "logical-call",
        ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
        traceId: trace.traceId,
      },
    },
    { config: params.ctx.config },
  );
  const options = params.options;
  const ctx = params.ctx;
  const traceparent = formatPropagatedDiagnosticTraceparent(trace);
  const originalOnPayload = options?.onPayload;
  const originalOnResponse = options?.onResponse;
  const onPayload: NonNullable<ModelCallStreamOptions>["onPayload"] = (payload, model) => {
    const requestBody = modelRequestBodyState(requestOptions);
    if (requestBody.enabled || requestBody.reportsBytes) {
      return originalOnPayload?.(payload, model);
    }
    if (!originalOnPayload) {
      observer.assignRequestPayloadBytes(payload);
      return undefined;
    }
    const result = originalOnPayload(payload, model);
    const observeReplacement = (replacement: unknown) => {
      observer.assignRequestPayloadBytes(replacement ?? payload);
      return replacement;
    };
    return isPromiseLike(result) ? result.then(observeReplacement) : observeReplacement(result);
  };
  const onResponse: NonNullable<ModelCallStreamOptions>["onResponse"] = (response, model) => {
    // Retrying providers can expose several responses; the terminal request status
    // is the latest response observed before the model call completes or fails.
    if (!observer.state.terminalEventEmitted) {
      observer.state.responseStatus = response.status;
      observer.state.lastProviderActivityAtMs = Date.now();
    }
    return originalOnResponse?.(response, model);
  };

  const headers: ModelRequestHeaders = {};
  for (const [key, value] of Object.entries(options?.headers ?? {})) {
    if (key.toLowerCase() === TRACEPARENT_HEADER_NAME) {
      continue;
    }
    headers[key] = value;
  }
  if (traceparent) {
    headers[TRACEPARENT_HEADER_NAME] = traceparent;
  }
  const requestOptions = {
    ...options,
    requestId: callId,
    ...((options?.headers || traceparent) && { headers }),
    onPayload: markModelPayloadObserver(onPayload, originalOnPayload),
    onResponse,
  };
  modelRequestBodyState(requestOptions).onBytes = (bytes) => {
    observer.state.requestPayloadBytes = bytes;
    emitDiagnosticsTimelineEvent(
      {
        type: "mark",
        name: "provider.request.serialized",
        timestamp: new Date().toISOString(),
        runId: ctx.runId,
        spanId: callId,
      },
      { config: ctx.config },
    );
  };
  const propagatedOptions = withProviderAcceptanceObserver(requestOptions, (acceptance) => {
    if (observer.state.terminalEventEmitted) {
      return;
    }
    observer.state.lastProviderActivityAtMs = Date.now();
    observer.state.providerAcceptanceKind = acceptance.kind;
    if (acceptance.kind === "http_response") {
      observer.state.responseStatus = acceptance.status;
    }
  });
  let waitReason: "response" | "slot" | null = null;
  let firstEventObserved = false;
  const trackStatusDelivery = captureAsyncWorkTracker();
  const signal = params.options?.signal;
  function reportStatus(data: Record<string, unknown>) {
    const event = { stream: "run_status" as const, data };
    emitAgentEvent({ runId: params.ctx.runId, sessionKey: params.ctx.sessionKey, ...event });
    if (params.ctx.onAgentEvent) {
      void trackStatusDelivery(async () => {
        try {
          await params.ctx.onAgentEvent?.(event);
        } catch {
          log.warn("Provider wait status delivery failed");
        }
      });
    }
  }
  const reportWait: NonNullable<NonNullable<ModelCallStreamOptions>["onProviderWait"]> = (
    reason,
  ) => {
    if (
      reason === waitReason ||
      (reason !== null &&
        (firstEventObserved || signal?.aborted || observer.state.terminalEventEmitted))
    ) {
      return;
    }
    waitReason = reason;
    if (runContext) {
      if (reason) {
        runContext.localModelWait = { requestId: callId };
      } else if (runContext.localModelWait?.requestId === callId) {
        delete runContext.localModelWait;
      }
    }
    reportStatus(reason ? { phase: "waiting_for_model", reason } : { phase: "starting_model" });
    params.options?.onProviderWait?.(reason);
  };
  const clearWait = () => reportWait(null);
  propagatedOptions.onProviderWait = reportWait;
  signal?.addEventListener("abort", clearWait, { once: true });
  function emitModelCallEnded(failure: { error: unknown } | undefined): void {
    const { ownerGeneration, config } = params.ctx;
    if (observer.state.reasoningSuppressed) {
      const warning = recordReasoningSuppressedDiagnostic(
        {
          sessionKey: eventBase.sessionKey,
          sessionId: eventBase.sessionId ?? (eventBase.sessionKey ? undefined : eventBase.runId),
        },
        eventBase.provider,
        eventBase.model,
      );
      if (warning) {
        log.warn(warning);
      }
    }
    if (observer.state.terminalEventEmitted) {
      return;
    }
    clearWait();
    signal?.removeEventListener("abort", clearWait);
    observer.state.terminalEventEmitted = true;
    const terminalAtMs = Date.now();
    const durationMs = terminalAtMs - startedAt;
    const providerTimingFields: Record<string, number> =
      observer.state.providerProcessingMs === undefined
        ? {}
        : {
            providerProcessingMs: observer.state.providerProcessingMs,
            // Includes queueing, loading, transport, and terminal settlement overhead.
            providerWaitEstimateMs: Math.max(0, durationMs - observer.state.providerProcessingMs),
          };
    const sizeTimingFields = observer.sizeTimingFields();
    const fields = failure ? modelCallErrorFields(failure.error) : undefined;
    const terminal = fields
      ? { type: "model.call.error" as const, ...fields }
      : { type: "model.call.completed" as const };
    const errorStatus = failure ? diagnosticHttpStatusCode(failure.error) : undefined;
    const responseStatus =
      observer.state.responseStatus ??
      (errorStatus === undefined ? undefined : Number(errorStatus));
    const terminalReason = failure
      ? observer.state.terminalReason === "aborted"
        ? "aborted"
        : (fields?.failureKind ?? "error")
      : (observer.state.terminalReason ?? "unknown");
    const { providerAcceptanceKind } = observer.state;
    const provider = boundedTimelineAttribute(eventBase.provider);
    const model = boundedTimelineAttribute(eventBase.model);
    const api = boundedTimelineAttribute(eventBase.api);
    const transport = boundedTimelineAttribute(eventBase.transport);
    emitDiagnosticsTimelineEvent(
      {
        type: "provider.request",
        name: "provider.request",
        timestamp: new Date(startedAt).toISOString(),
        runId: eventBase.runId,
        spanId: eventBase.callId,
        durationMs,
        provider,
        operation: api ?? transport ?? "model.call",
        ok: failure === undefined,
        ...(responseStatus !== undefined ? { status: responseStatus } : {}),
        attributes: {
          observationUnit: "logical-call",
          ...modelUsageTimelineAttributes(observer.terminalFields().usage),
          ...(observer.state.responseModel ? { responseModel: observer.state.responseModel } : {}),
          ...(eventBase.sessionId ? { sessionId: eventBase.sessionId } : {}),
          traceId: trace.traceId,
          ...(model ? { model } : {}),
          ...(api ? { api } : {}),
          ...(transport ? { transport } : {}),
          terminalAtMs,
          ...providerTimingFields,
          ...(observer.state.lastProviderActivityAtMs !== undefined
            ? { lastProviderActivityAtMs: observer.state.lastProviderActivityAtMs }
            : {}),
          terminalReason,
          providerAccepted: providerAcceptanceKind !== undefined,
          ...(providerAcceptanceKind ? { providerAcceptanceKind } : {}),
        },
      },
      { config },
    );
    emitCoreModelRequestEndedDiagnosticEvent(
      {
        ...terminal,
        ...eventBase,
        durationMs,
        ...providerTimingFields,
        ...sizeTimingFields,
        ...observer.terminalFields(),
      },
      ownerGeneration,
      modelContentPrivateData(observer.completedContent()),
    );
    if (!observer.state.suppressPluginHooks) {
      dispatchModelCallHook(eventBase, {
        durationMs,
        outcome: failure ? "error" : "completed",
        ...sizeTimingFields,
        ...fields,
      });
    }
  }
  let terminalNotified = false;
  let finishedNotified = false;
  const notifyFinished = () => {
    if (!finishedNotified) {
      finishedNotified = true;
      transportContext.onRateLimitWait = undefined;
      clearWait();
      signal?.removeEventListener("abort", clearWait);
      params.ctx.onFinished?.(callId);
    }
  };
  try {
    params.ctx.onStarted?.(callId);
  } catch (error) {
    notifyFinished();
    throw error;
  }
  return {
    eventBase,
    observer,
    propagatedOptions,
    runInTransportContext<T>(run: () => T): T {
      return withModelTransportContext(transportContext, run);
    },
    startedAt,
    observeChunk(chunk: unknown) {
      firstEventObserved = true;
      clearWait();
      observer.observeResponseChunk(startedAt, chunk);
      reportStreamProgress(observer.state.terminalEventEmitted ? undefined : callId);
      if (params.ctx.onOutputDelta && isModelOutputDelta(chunk)) {
        params.ctx.onOutputDelta();
      }
    },
    emitCompleted() {
      try {
        // Iterator exhaustion can emit diagnostics before result() supplies the terminal response.
        if (
          !terminalNotified &&
          (observer.state.terminalSucceeded || observer.state.terminalError)
        ) {
          terminalNotified = true;
          params.ctx.onTerminal?.();
          if (observer.state.terminalSucceeded && !observer.state.terminalError) {
            params.ctx.onSucceeded?.(startedAt);
          }
        }
        emitModelCallEnded(
          observer.state.terminalError ? { error: observer.state.terminalError } : undefined,
        );
      } finally {
        notifyFinished();
      }
    },
    emitError(err: unknown) {
      try {
        emitModelCallEnded({ error: err });
      } finally {
        notifyFinished();
      }
    },
  };
}

export type ModelCallLifecycle = ReturnType<typeof createModelLifecycle>;
