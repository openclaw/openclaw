import type { DiagnosticEventPayload, OpenClawPluginApi } from "openclaw/plugin-sdk";
import { onDiagnosticEvent } from "openclaw/plugin-sdk";
import type { PostHogPluginConfig, RunState } from "./types.js";
import { buildAiGeneration, buildAiSpan, buildAiTrace } from "./events.js";
import { generateSpanId, generateTraceId } from "./utils.js";

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

  let client: import("posthog-node").PostHog | null = null;
  let unsubscribe: (() => void) | null = null;

  function getOrCreateTraceId(sessionKey: string | undefined, runId: string): string {
    if (!sessionKey) {
      return generateTraceId();
    }

    const existingTraceId = traces.get(sessionKey);
    const prevRunId = lastRunId.get(sessionKey);

    // Same runId = same message cycle (e.g. tool-use continuation within one
    // agent invocation). Reuse the existing trace.
    if (existingTraceId && prevRunId === runId) {
      return existingTraceId;
    }

    // New runId = new message cycle, start a fresh trace.
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
            const traceEvent = buildAiTrace(traceId, evt);
            client.capture({
              distinctId: traceEvent.distinctId,
              event: traceEvent.event,
              properties: traceEvent.properties,
            });
            // Clean up trace state after completion
            if (evt.sessionKey) {
              traces.delete(evt.sessionKey);
              generationSpans.delete(evt.sessionKey);
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
    },
  });

  // -- Lifecycle Hooks --

  api.on("llm_input", (event, ctx) => {
    cleanupStaleRuns();

    const traceId = getOrCreateTraceId(ctx.sessionKey, event.runId);
    const spanId = generateSpanId();

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
    }

    const generation = buildAiGeneration(runState, event, config.privacyMode);
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

    const span = buildAiSpan(traceId, parentSpanId, event, ctx, config.privacyMode);
    client.capture({
      distinctId: span.distinctId,
      event: span.event,
      properties: span.properties,
    });
  });
}
