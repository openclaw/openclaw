import { createPostHogClient, shutdownPostHogClient } from "./lib/posthog-client.js";
import { TraceContextManager, resolveSessionKey } from "./lib/trace-context.js";
import { emitGeneration, emitToolSpan, emitTrace, emitCustomEvent } from "./lib/event-mappers.js";
import { readPrivacyMode } from "./lib/privacy.js";
import type { PluginConfig } from "./lib/types.js";

export const id = "posthog-analytics";

const DEBUG = process.env.DENCHCLAW_POSTHOG_DEBUG === "1";

function debugLog(label: string, data: unknown): void {
  if (!DEBUG) return;
  try {
    process.stderr.write(`[posthog-analytics] ${label}: ${JSON.stringify(data, null, 2)}\n`);
  } catch { /* ignore serialization errors */ }
}

export default function register(api: any) {
  const config: PluginConfig | undefined =
    api.config?.plugins?.entries?.["posthog-analytics"]?.config;

  if (!config?.apiKey) return;
  if (config.enabled === false) return;

  const ph = createPostHogClient(config.apiKey, config.host);
  const traceCtx = new TraceContextManager();

  const getPrivacyMode = () => readPrivacyMode(api.config);

  const getConfigModel = (): string | undefined =>
    api.config?.agents?.defaults?.model?.primary;

  const ensureTrace = (ctx: any): void => {
    const sk = resolveSessionKey(ctx);
    if (traceCtx.getTrace(sk)) return;
    traceCtx.startTrace(sk, ctx.runId ?? sk);
    const model = getConfigModel();
    if (model) traceCtx.setModel(sk, model);
  };

  api.on(
    "before_model_resolve",
    (event: any, ctx: any) => {
      debugLog("before_model_resolve event", event);
      debugLog("before_model_resolve ctx", { runId: ctx.runId, sessionId: ctx.sessionId, sessionKey: ctx.sessionKey });

      const sk = resolveSessionKey(ctx);
      traceCtx.startTrace(sk, ctx.runId ?? sk);
      const model = event.modelOverride || getConfigModel();
      if (model) {
        traceCtx.setModel(sk, model);
      }
    },
    { priority: -10 },
  );

  api.on(
    "before_prompt_build",
    (_event: any, ctx: any) => {
      debugLog("before_prompt_build ctx", { runId: ctx.runId, sessionId: ctx.sessionId, hasMessages: Boolean(ctx.messages) });

      const sk = resolveSessionKey(ctx);
      ensureTrace(ctx);
      if (ctx.messages) {
        traceCtx.setInput(sk, ctx.messages, getPrivacyMode());
      }
    },
    { priority: -10 },
  );

  api.on(
    "before_tool_call",
    (event: any, ctx: any) => {
      debugLog("before_tool_call", { toolName: event.toolName, runId: ctx.runId, sessionId: ctx.sessionId });

      const sk = resolveSessionKey(ctx);
      ensureTrace(ctx);
      traceCtx.startToolSpan(sk, event.toolName, event.params);
    },
    { priority: -10 },
  );

  api.on(
    "after_tool_call",
    (event: any, ctx: any) => {
      debugLog("after_tool_call", { toolName: event.toolName, runId: ctx.runId, sessionId: ctx.sessionId, hasError: Boolean(event.error), durationMs: event.durationMs });

      const sk = resolveSessionKey(ctx);
      ensureTrace(ctx);
      traceCtx.endToolSpan(sk, event.toolName, event.result);
      emitToolSpan(ph, traceCtx, sk, event, getPrivacyMode());
    },
    { priority: -10 },
  );

  api.on(
    "agent_end",
    (event: any, ctx: any) => {
      debugLog("agent_end event", { success: event.success, error: event.error, durationMs: event.durationMs, messageCount: event.messages?.length });
      debugLog("agent_end ctx", { runId: ctx.runId, sessionId: ctx.sessionId });

      const sk = resolveSessionKey(ctx);
      ensureTrace(ctx);

      const trace = traceCtx.getTrace(sk);
      if (trace && !trace.model) {
        const model = getConfigModel();
        if (model) traceCtx.setModel(sk, model);
      }

      emitGeneration(ph, traceCtx, sk, event, getPrivacyMode());
      emitTrace(ph, traceCtx, sk, event, getPrivacyMode());
      emitCustomEvent(ph, "dench_turn_completed", {
        session_id: sk,
        run_id: ctx.runId,
        model: traceCtx.getModel(sk),
      });
      traceCtx.endTrace(sk);
    },
    { priority: -10 },
  );

  api.on(
    "message_received",
    (event: any, ctx: any) => {
      emitCustomEvent(ph, "dench_message_received", {
        channel: ctx.channel ?? ctx.channelId,
        session_id: ctx.sessionId,
        has_attachments: Boolean(event.attachments?.length),
      });
    },
    { priority: -10 },
  );

  api.on(
    "session_start",
    (_event: any, ctx: any) => {
      emitCustomEvent(ph, "dench_session_start", {
        session_id: ctx.sessionId,
        channel: ctx.channel ?? ctx.channelId,
      });
    },
    { priority: -10 },
  );

  api.on(
    "session_end",
    (_event: any, ctx: any) => {
      emitCustomEvent(ph, "dench_session_end", {
        session_id: ctx.sessionId,
        channel: ctx.channel ?? ctx.channelId,
      });
    },
    { priority: -10 },
  );

  api.registerService({
    id: "posthog-analytics",
    start: () => api.logger.info("[posthog-analytics] service started"),
    stop: () => shutdownPostHogClient(ph),
  });
}
