import type { DiagnosticEventPayload, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import type { PostHogPluginConfig, RunState } from "./types.js";
import { buildAiGeneration, buildAiSpan, buildAiTrace } from "./events.js";
import { generateSpanId, generateTraceId, parseLastAssistant } from "./utils.js";

const DEFAULT_HOST = "https://us.i.posthog.com";
const STALE_RUN_MS = 5 * 60 * 1000;

export function registerPostHogHooks(api: OpenClawPluginApi, config: PostHogPluginConfig) {
  /** In-flight LLM runs keyed by runId */
  const runs = new Map<string, RunState>();
  /** Active trace IDs keyed by sessionKey */
  const traces = new Map<string, string>();
  /** Most recent generation spanId keyed by sessionKey, used as parent for tool spans */
  const generationSpans = new Map<string, string>();
  /** Last runId seen per sessionKey — a new runId means a new message cycle */
  const lastRunId = new Map<string, string>();
  /** Timestamp of last llm_output per sessionKey — used for session window timeout */
  const lastOutputAt = new Map<string, number>();
  /** Accumulated token totals per traceId for $ai_trace */
  const traceTokens = new Map<string, { input: number; output: number }>();
  /** Session window IDs keyed by sessionKey — windowed $ai_session_id */
  const sessionWindows = new Map<string, { sessionId: string; lastOutputAt: number }>();

  let client: import("posthog-node").PostHog | null = null;
  let unsubscribe: (() => void) | null = null;

  function getOrCreateSessionId(sessionKey: string): string {
    const existing = sessionWindows.get(sessionKey);
    const timeoutMs = config.sessionWindowMinutes * 60_000;

    if (existing && Date.now() - existing.lastOutputAt < timeoutMs) {
      return existing.sessionId;
    }

    // New window — generate windowed session ID
    const windowId = generateSpanId().slice(0, 8);
    const sessionId = `${sessionKey}:${windowId}`;
    sessionWindows.set(sessionKey, { sessionId, lastOutputAt: Date.now() });
    return sessionId;
  }

  function getOrCreateTraceId(sessionKey: string | undefined, runId: string): string {
    if (!sessionKey) {
      return generateTraceId();
    }

    if (config.traceGrouping === "session") {
      const existing = traces.get(sessionKey);
      const lastOutput = lastOutputAt.get(sessionKey);
      const timeoutMs = config.sessionWindowMinutes * 60_000;

      // Reuse trace if it exists and hasn't timed out
      if (existing && lastOutput && Date.now() - lastOutput < timeoutMs) {
        return existing;
      }

      // Otherwise start a new trace
      const traceId = generateTraceId();
      traces.set(sessionKey, traceId);
      return traceId;
    }

    // "message" mode (default) — split on runId change
    const prevRunId = lastRunId.get(sessionKey);
    const existing = traces.get(sessionKey);
    if (existing && prevRunId === runId) {
      return existing;
    }

    lastRunId.set(sessionKey, runId);
    const traceId = generateTraceId();
    traces.set(sessionKey, traceId);
    return traceId;
  }

  function cleanupStaleRuns() {
    const now = Date.now();
    for (const [runId, state] of runs) {
      if (now - state.startTime > STALE_RUN_MS) {
        runs.delete(runId);
      }
    }
  }

  // Register the background service that manages the PostHog client lifecycle
  api.registerService({
    id: "posthog",
    async start() {
      const { PostHog: PostHogClient } = await import("posthog-node");
      client = new PostHogClient(config.apiKey, {
        host: config.host || DEFAULT_HOST,
        flushAt: 20,
        flushInterval: 10_000,
      });

      // Subscribe to diagnostic events for $ai_trace capture
      unsubscribe = onDiagnosticEvent((evt: DiagnosticEventPayload) => {
        if (!client) return;

        if (evt.type === "message.processed") {
          const traceId = evt.sessionKey ? traces.get(evt.sessionKey) : undefined;
          if (traceId) {
            const tokenTotals = traceTokens.get(traceId);
            const sessionId = evt.sessionKey
              ? sessionWindows.get(evt.sessionKey)?.sessionId
              : undefined;
            const traceEvent = buildAiTrace(traceId, evt, tokenTotals, sessionId);
            client.capture({
              distinctId: traceEvent.distinctId,
              event: traceEvent.event,
              properties: traceEvent.properties,
            });
            // In message mode, clean up trace state after completion.
            // In session mode, keep the trace alive for reuse across messages.
            if (evt.sessionKey && config.traceGrouping !== "session") {
              traces.delete(evt.sessionKey);
              generationSpans.delete(evt.sessionKey);
              traceTokens.delete(traceId);
            }
          }
        }
      });
    },
    async stop() {
      unsubscribe?.();
      unsubscribe = null;
      if (client) {
        await client.shutdown();
        client = null;
      }
      runs.clear();
      traces.clear();
      generationSpans.clear();
      lastRunId.clear();
      lastOutputAt.clear();
      traceTokens.clear();
      sessionWindows.clear();
    },
  });

  // -- Lifecycle Hooks --

  api.on("llm_input", (event, ctx) => {
    cleanupStaleRuns();

    const traceId = getOrCreateTraceId(ctx.sessionKey, event.runId);
    const spanId = generateSpanId();
    const sessionId = ctx.sessionKey ? getOrCreateSessionId(ctx.sessionKey) : undefined;

    // Build the input message array: system prompt + history + current prompt
    let input: unknown[] | null = null;
    if (!config.privacyMode) {
      input = [];
      if (event.systemPrompt) {
        input.push({ role: "system", content: event.systemPrompt });
      }
      input.push(...event.historyMessages, event.prompt);
    }

    runs.set(event.runId, {
      traceId,
      spanId,
      startTime: Date.now(),
      model: event.model,
      provider: event.provider,
      input,
      sessionKey: ctx.sessionKey,
      sessionId,
      channel: ctx.messageProvider,
      agentId: ctx.agentId,
    });
  });

  api.on("llm_output", (event, ctx) => {
    if (!client) return;

    const runState = runs.get(event.runId);
    if (!runState) return;
    runs.delete(event.runId);

    // Track the generation spanId for tool call parenting.
    const sessionKey = ctx.sessionKey;
    if (sessionKey) {
      generationSpans.set(sessionKey, runState.spanId);
      // Track lastOutputAt in both modes for session windowing and trace timeout
      const now = Date.now();
      lastOutputAt.set(sessionKey, now);
      const window = sessionWindows.get(sessionKey);
      if (window) {
        window.lastOutputAt = now;
      }
    }

    const lastAssistant = parseLastAssistant((event as Record<string, unknown>).lastAssistant);

    // Accumulate token totals for the trace
    const inputTokens = event.usage?.input ?? 0;
    const outputTokens = event.usage?.output ?? 0;
    if (inputTokens > 0 || outputTokens > 0) {
      const existing = traceTokens.get(runState.traceId);
      if (existing) {
        existing.input += inputTokens;
        existing.output += outputTokens;
      } else {
        traceTokens.set(runState.traceId, { input: inputTokens, output: outputTokens });
      }
    }

    const generation = buildAiGeneration(runState, event, config.privacyMode, lastAssistant);
    client.capture({
      distinctId: generation.distinctId,
      event: generation.event,
      properties: generation.properties,
    });
  });

  api.on("after_tool_call", (event, ctx) => {
    if (!client) return;

    const traceId = ctx.sessionKey ? traces.get(ctx.sessionKey) : undefined;
    if (!traceId) return;

    const parentSpanId = ctx.sessionKey ? generationSpans.get(ctx.sessionKey) : undefined;
    const sessionId = ctx.sessionKey ? sessionWindows.get(ctx.sessionKey)?.sessionId : undefined;

    const span = buildAiSpan(traceId, parentSpanId, event, ctx, config.privacyMode, sessionId);
    client.capture({
      distinctId: span.distinctId,
      event: span.event,
      properties: span.properties,
    });
  });
}
