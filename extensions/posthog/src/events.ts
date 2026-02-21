import type {
  DiagnosticMessageProcessedEvent,
  PluginHookAfterToolCallEvent,
  PluginHookLlmOutputEvent,
  PluginHookToolContext,
} from "openclaw/plugin-sdk";
import type { RunState } from "./types.js";
import {
  formatInputMessages,
  formatOutputChoices,
  generateSpanId,
  redactForPrivacy,
  safeStringify,
} from "./utils.js";

export type AiGenerationEvent = {
  event: "$ai_generation";
  distinctId: string;
  properties: Record<string, unknown>;
};

export type AiSpanEvent = {
  event: "$ai_span";
  distinctId: string;
  properties: Record<string, unknown>;
};

export type AiTraceEvent = {
  event: "$ai_trace";
  distinctId: string;
  properties: Record<string, unknown>;
};

export function buildAiGeneration(
  runState: RunState,
  output: PluginHookLlmOutputEvent,
  privacyMode: boolean,
): AiGenerationEvent {
  const latency = (Date.now() - runState.startTime) / 1000;
  const distinctId = runState.sessionKey ?? output.runId;

  return {
    event: "$ai_generation",
    distinctId,
    properties: {
      $ai_trace_id: runState.traceId,
      $ai_session_id: runState.sessionKey ?? null,
      $ai_span_id: runState.spanId,
      $ai_model: output.model,
      $ai_provider: output.provider,
      $ai_input: redactForPrivacy(formatInputMessages(runState.input), privacyMode),
      $ai_output_choices: redactForPrivacy(formatOutputChoices(output.assistantTexts), privacyMode),
      $ai_input_tokens: output.usage?.input ?? null,
      $ai_output_tokens: output.usage?.output ?? null,
      $ai_latency: latency,
      $ai_is_error: false,
      $ai_error: null,
      $ai_lib: "posthog-openclaw",
      $ai_framework: "openclaw",
      cache_read_input_tokens: output.usage?.cacheRead ?? null,
      cache_creation_input_tokens: output.usage?.cacheWrite ?? null,
      $ai_channel: runState.channel ?? null,
      $ai_agent_id: runState.agentId ?? null,
    },
  };
}

export function buildAiSpan(
  traceId: string,
  parentSpanId: string | undefined,
  event: PluginHookAfterToolCallEvent,
  ctx: PluginHookToolContext,
  privacyMode: boolean,
): AiSpanEvent {
  const distinctId = ctx.sessionKey ?? "unknown";
  const spanId = generateSpanId();
  const latency = typeof event.durationMs === "number" ? event.durationMs / 1000 : null;

  return {
    event: "$ai_span",
    distinctId,
    properties: {
      $ai_trace_id: traceId,
      $ai_session_id: ctx.sessionKey ?? null,
      $ai_span_id: spanId,
      $ai_parent_id: parentSpanId ?? null,
      $ai_span_name: event.toolName,
      $ai_input_state: redactForPrivacy(safeStringify(event.params), privacyMode),
      $ai_output_state: redactForPrivacy(safeStringify(event.result), privacyMode),
      $ai_latency: latency,
      $ai_is_error: !!event.error,
      $ai_error: event.error ?? null,
      $ai_lib: "posthog-openclaw",
      $ai_framework: "openclaw",
      $ai_channel: null,
      $ai_agent_id: ctx.agentId ?? null,
    },
  };
}

export function buildAiTrace(
  traceId: string,
  event: DiagnosticMessageProcessedEvent,
): AiTraceEvent {
  const distinctId = event.sessionKey ?? "unknown";
  const latency = typeof event.durationMs === "number" ? event.durationMs / 1000 : null;

  return {
    event: "$ai_trace",
    distinctId,
    properties: {
      $ai_trace_id: traceId,
      $ai_session_id: event.sessionKey ?? null,
      $ai_latency: latency,
      $ai_is_error: event.outcome === "error",
      $ai_error: event.error ?? null,
      $ai_lib: "posthog-openclaw",
      $ai_framework: "openclaw",
      $ai_channel: event.channel ?? null,
    },
  };
}
