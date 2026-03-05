import { createHash } from "node:crypto";
import os from "node:os";
import type { PostHogClient } from "./posthog-client.js";
import type { TraceContextManager } from "./trace-context.js";
import { sanitizeMessages, sanitizeOutputChoices, stripSecrets } from "./privacy.js";

function getAnonymousId(): string {
  try {
    const raw = `${os.hostname()}:${os.userInfo().username}`;
    return createHash("sha256").update(raw).digest("hex").slice(0, 16);
  } catch {
    return "unknown";
  }
}

/**
 * Extract actual token counts and cost from OpenClaw's per-message usage metadata.
 */
export function extractUsageFromMessages(messages: unknown): {
  inputTokens: number;
  outputTokens: number;
  totalCostUsd: number;
} {
  if (!Array.isArray(messages)) return { inputTokens: 0, outputTokens: 0, totalCostUsd: 0 };
  let inputTokens = 0;
  let outputTokens = 0;
  let totalCostUsd = 0;
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") continue;
    const usage = m.usage as Record<string, unknown> | undefined;
    if (!usage) continue;
    if (typeof usage.input === "number") inputTokens += usage.input;
    if (typeof usage.output === "number") outputTokens += usage.output;
    const cost = usage.cost as Record<string, unknown> | undefined;
    if (cost && typeof cost.total === "number") totalCostUsd += cost.total;
  }
  return { inputTokens, outputTokens, totalCostUsd };
}

/**
 * Extract tool call names from the messages array provided by agent_end.
 * Works regardless of privacy mode since tool names are metadata, not content.
 */
export function extractToolNamesFromMessages(messages: unknown): string[] {
  if (!Array.isArray(messages)) return [];
  const names: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;

    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        const name = (tc as any)?.function?.name ?? (tc as any)?.name;
        if (typeof name === "string" && name) names.push(name);
      }
    }
    if (Array.isArray(m.content)) {
      for (const block of m.content) {
        if ((block as any)?.type === "tool_use" && typeof (block as any)?.name === "string") {
          names.push((block as any).name);
        }
        if ((block as any)?.type === "toolCall" && typeof (block as any)?.name === "string") {
          names.push((block as any).name);
        }
        if ((block as any)?.type === "tool-call" && typeof (block as any)?.toolName === "string") {
          names.push((block as any).toolName);
        }
      }
    }
    if (m.role === "tool" && typeof m.name === "string") {
      names.push(m.name);
    }
  }
  return [...new Set(names)];
}

/**
 * Normalize OpenClaw's message format into OpenAI-compatible output choices
 * so PostHog can extract tool calls for the Tools tab.
 */
export function normalizeOutputForPostHog(messages: unknown): unknown[] | undefined {
  if (!Array.isArray(messages)) return undefined;
  const choices: unknown[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;
    if (m.role !== "assistant") continue;

    const toolCalls: unknown[] = [];
    let textContent = "";

    if (Array.isArray(m.content)) {
      for (const block of m.content as Array<Record<string, unknown>>) {
        if (block.type === "text" && typeof block.text === "string") {
          textContent += block.text;
        }
        if (block.type === "toolCall" && typeof block.name === "string") {
          toolCalls.push({
            id: block.id ?? block.toolCallId,
            type: "function",
            function: {
              name: block.name,
              arguments: typeof block.arguments === "string"
                ? block.arguments
                : JSON.stringify(block.arguments ?? {}),
            },
          });
        }
      }
    } else if (typeof m.content === "string") {
      textContent = m.content;
    }

    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls as Array<Record<string, unknown>>) {
        toolCalls.push(tc);
      }
    }

    const choice: Record<string, unknown> = {
      role: "assistant",
      content: textContent || null,
    };
    if (toolCalls.length > 0) {
      choice.tool_calls = toolCalls;
    }
    choices.push(choice);
  }
  return choices.length > 0 ? choices : undefined;
}

/**
 * Build full conversation state for the $ai_trace event.
 * Splits messages into input (user/tool/system) and output (assistant) arrays,
 * preserving chronological order so PostHog renders the full conversation.
 */
export function buildTraceState(
  messages: unknown,
  privacyMode: boolean,
): { inputState: unknown; outputState: unknown } {
  if (!Array.isArray(messages)) return { inputState: undefined, outputState: undefined };

  const inputMessages: unknown[] = [];
  const outputMessages: unknown[] = [];

  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const m = msg as Record<string, unknown>;

    const extractText = () => {
      if (Array.isArray(m.content)) {
        return (m.content as Array<Record<string, unknown>>)
          .filter((b) => b.type === "text")
          .map((b) => b.text)
          .join("");
      }
      return typeof m.content === "string" ? m.content : null;
    };

    if (m.role === "assistant") {
      const content = privacyMode ? "[REDACTED]" : extractText();
      const entry: Record<string, unknown> = { role: "assistant", content };

      const toolNames = extractToolNamesFromSingleMessage(m);
      if (toolNames.length > 0) {
        entry.tool_calls = toolNames.map((name) => ({
          type: "function",
          function: { name },
        }));
      }

      outputMessages.push(entry);
    } else if (m.role === "user" || m.role === "tool" || m.role === "toolResult" || m.role === "system") {
      const content = privacyMode ? "[REDACTED]" : extractText();
      const entry: Record<string, unknown> = { role: m.role, content };
      if (m.name) entry.name = m.name;
      if (m.toolName) entry.toolName = m.toolName;
      inputMessages.push(entry);
    }
  }

  return {
    inputState: inputMessages.length > 0 ? inputMessages : undefined,
    outputState: outputMessages.length > 0 ? outputMessages : undefined,
  };
}

function extractToolNamesFromSingleMessage(m: Record<string, unknown>): string[] {
  const names: string[] = [];
  if (Array.isArray(m.tool_calls)) {
    for (const tc of m.tool_calls) {
      const name = (tc as any)?.function?.name ?? (tc as any)?.name;
      if (typeof name === "string" && name) names.push(name);
    }
  }
  if (Array.isArray(m.content)) {
    for (const block of m.content) {
      if ((block as any)?.type === "toolCall" && typeof (block as any)?.name === "string") {
        names.push((block as any).name);
      }
    }
  }
  return names;
}

/**
 * Emit a `$ai_generation` event from the agent_end hook data.
 */
export function emitGeneration(
  ph: PostHogClient,
  traceCtx: TraceContextManager,
  sessionKey: string,
  event: any,
  privacyMode: boolean,
): void {
  try {
    const trace = traceCtx.getTrace(sessionKey);
    if (!trace) return;

    const latency = event.durationMs != null
      ? event.durationMs / 1_000
      : trace.startedAt
        ? (Date.now() - trace.startedAt) / 1_000
        : undefined;

    const spanToolNames = trace.toolSpans.map((s) => s.toolName);
    const messageToolNames = extractToolNamesFromMessages(event.messages);
    const allToolNames = [...new Set([...spanToolNames, ...messageToolNames])];

    const properties: Record<string, unknown> = {
      $ai_trace_id: trace.traceId,
      $ai_session_id: trace.sessionId,
      $ai_model: trace.model ?? event.model ?? "unknown",
      $ai_provider: trace.provider ?? event.provider,
      $ai_latency: latency,
      $ai_tools: allToolNames.length > 0
        ? allToolNames.map((name) => ({ type: "function", function: { name } }))
        : undefined,
      $ai_stream: event.stream,
      $ai_temperature: event.temperature,
      $ai_is_error: event.success === false || Boolean(event.error),
    };

    if (event.usage) {
      const inputTokens = event.usage.inputTokens ?? event.usage.input_tokens;
      const outputTokens = event.usage.outputTokens ?? event.usage.output_tokens;
      if (inputTokens != null && inputTokens > 0) properties.$ai_input_tokens = inputTokens;
      if (outputTokens != null && outputTokens > 0) properties.$ai_output_tokens = outputTokens;
      const cost = event.cost?.totalUsd ?? event.cost?.total_usd;
      if (cost != null && cost > 0) properties.$ai_total_cost_usd = cost;
    } else if (event.messages) {
      const extracted = extractUsageFromMessages(event.messages);
      if (extracted.inputTokens > 0) properties.$ai_input_tokens = extracted.inputTokens;
      if (extracted.outputTokens > 0) properties.$ai_output_tokens = extracted.outputTokens;
      if (extracted.totalCostUsd > 0) properties.$ai_total_cost_usd = extracted.totalCostUsd;
    }

    properties.$ai_input = sanitizeMessages(trace.input, privacyMode);

    const outputChoices = normalizeOutputForPostHog(event.messages);
    properties.$ai_output_choices = sanitizeOutputChoices(
      outputChoices ?? event.output ?? event.messages,
      privacyMode,
    );

    if (event.error) {
      properties.$ai_error = typeof event.error === "string"
        ? event.error
        : event.error?.message ?? String(event.error);
    }

    ph.capture({
      distinctId: getAnonymousId(),
      event: "$ai_generation",
      properties,
    });
  } catch {
    // Never crash the gateway for telemetry failures.
  }
}

/**
 * Emit a `$ai_span` event for a completed tool call.
 */
export function emitToolSpan(
  ph: PostHogClient,
  traceCtx: TraceContextManager,
  sessionKey: string,
  event: any,
  privacyMode: boolean,
): void {
  try {
    const trace = traceCtx.getTrace(sessionKey);
    const span = traceCtx.getLastToolSpan(sessionKey);
    if (!trace || !span) return;

    const latency = span.startedAt && span.endedAt
      ? (span.endedAt - span.startedAt) / 1_000
      : event.durationMs != null
        ? event.durationMs / 1_000
        : undefined;

    const properties: Record<string, unknown> = {
      $ai_trace_id: trace.traceId,
      $ai_session_id: trace.sessionId,
      $ai_span_id: span.spanId,
      $ai_span_name: span.toolName,
      $ai_parent_id: trace.traceId,
      $ai_latency: latency,
      $ai_is_error: span.isError ?? Boolean(event.error),
    };

    if (!privacyMode) {
      properties.tool_params = stripSecrets(span.params);
      properties.tool_result = stripSecrets(span.result);
    }

    ph.capture({
      distinctId: getAnonymousId(),
      event: "$ai_span",
      properties,
    });
  } catch {
    // Fail silently.
  }
}

/**
 * Emit a `$ai_trace` event for the completed agent run.
 */
export function emitTrace(
  ph: PostHogClient,
  traceCtx: TraceContextManager,
  sessionKey: string,
  event?: any,
  privacyMode?: boolean,
): void {
  try {
    const trace = traceCtx.getTrace(sessionKey);
    if (!trace) return;

    const latency = trace.startedAt
      ? (Date.now() - trace.startedAt) / 1_000
      : undefined;

    const { inputState, outputState } = buildTraceState(
      event?.messages,
      privacyMode ?? true,
    );

    ph.capture({
      distinctId: getAnonymousId(),
      event: "$ai_trace",
      properties: {
        $ai_trace_id: trace.traceId,
        $ai_session_id: trace.sessionId,
        $ai_latency: latency,
        $ai_span_name: "agent_run",
        $ai_input_state: inputState,
        $ai_output_state: outputState,
        tool_count: trace.toolSpans.length,
      },
    });
  } catch {
    // Fail silently.
  }
}

/**
 * Emit a custom DenchClaw event (not a PostHog $ai_* event).
 */
export function emitCustomEvent(
  ph: PostHogClient,
  eventName: string,
  properties?: Record<string, unknown>,
): void {
  try {
    ph.capture({
      distinctId: getAnonymousId(),
      event: eventName,
      properties: {
        ...properties,
        $process_person_profile: false,
      },
    });
  } catch {
    // Fail silently.
  }
}
