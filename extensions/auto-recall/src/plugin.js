import { RecallCache, cacheKeyFor, normalizeCacheText } from "./cache.js";
import { createBackends, deriveChatType, normalizeConfig } from "./config.js";
import { InflightDeduper } from "./inflight.js";
import { buildInjection, hasActiveMemoryMarker } from "./injection.js";
import { createLogger } from "./logging.js";
import { isSyntheticOrInternalEnvelope, stripEnvelope } from "./strip-envelope.js";
import { createTriggerManager, getRecallTrigger, isInternalPrompt } from "./triggers.js";

function sessionKeyFor(ctx = {}, event = {}) {
  return (
    ctx.sessionKey ||
    event.sessionKey ||
    event?.metadata?.sessionKey ||
    ctx.conversationId ||
    event.conversationId ||
    event?.metadata?.conversationId
  );
}

function providerFor(ctx = {}, event = {}) {
  return (
    ctx.messageProvider ||
    event.messageProvider ||
    event?.metadata?.messageProvider ||
    event?.metadata?.provider
  );
}

function eligible(ctx, event, cfg) {
  const agentId = ctx?.agentId || event?.agentId || event?.metadata?.agentId;
  if (cfg.agents.length && (!agentId || !cfg.agents.includes(agentId))) {
    return { ok: false, reason: "agent" };
  }
  if (ctx?.trigger && ctx.trigger !== "user") {
    return { ok: false, reason: "trigger" };
  }
  const chatType = deriveChatType(ctx, event);
  if (!chatType || !cfg.allowedChatTypes.includes(chatType)) {
    return { ok: false, reason: "chat_type", chatType };
  }
  return {
    ok: true,
    agentId,
    chatType,
    provider: providerFor(ctx, event),
    sessionKey: sessionKeyFor(ctx, event),
  };
}

function timeoutController(parents, ms) {
  const controller = new AbortController();
  const signals = (Array.isArray(parents) ? parents : [parents]).filter(Boolean);
  const abort = (event) => {
    const signal = event?.target;
    controller.abort(signal?.reason || new Error("aborted"));
  };
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason || new Error("aborted"));
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }
  const timer = setTimeout(() => controller.abort(new Error("timeout")), ms).unref?.();
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signals.forEach((signal) => signal.removeEventListener?.("abort", abort));
    },
  };
}

function shouldCache(result) {
  if (result?.cache?.cacheable === false) {
    return false;
  }
  if (result?.diagnostics?.reason === "timeout" || result?.diagnostics?.reason === "aborted") {
    return false;
  }
  return ["ok", "not_found", "degraded", "error"].includes(result?.status);
}

async function runBackendChain({ backends, request, cache, inflight, logger }) {
  const degradedCandidates = [];
  for (const backend of backends) {
    const cacheProbeKey = cacheKeyFor({
      backend,
      text: request.normalizedText,
      session: request.session,
    });
    const cached = cache.get(cacheProbeKey);
    if (cached) {
      logger.info({
        event: "cache_hit",
        backend: backend.name,
        status: cached.status,
        confidence: cached.confidence,
      });
      if (cached.status === "ok" && Number(cached.confidence) >= request.minConfidence) {
        return { result: cached, backend, cached: true };
      }
      if (
        cached.status === "degraded" &&
        request.allowDegraded &&
        Number(cached.confidence) >= request.minConfidence
      ) {
        return { result: cached, backend, cached: true };
      }
      continue;
    }

    const { promise, hit } = inflight.run(cacheProbeKey, async () => backend.query(request));
    if (hit) {
      logger.info({ event: "inflight_hit", backend: backend.name });
    }
    const result = await promise;
    const fullCacheKey = cacheKeyFor({
      backend,
      text: request.normalizedText,
      session: request.session,
      suffix: result?.cache?.keySuffix || "",
    });

    logger.info({
      event: "backend_result",
      backend: backend.name,
      kind: backend.kind,
      status: result.status,
      confidence: result.confidence,
      diagnostics: result.diagnostics,
    });

    if (shouldCache(result)) {
      const ttl = cache.ttlFor(result.status, result.cache?.ttlMs);
      if (cache.set(fullCacheKey, result, ttl)) {
        logger.info({
          event: "cache_set",
          backend: backend.name,
          status: result.status,
          ttlMs: ttl,
        });
      }
      if (fullCacheKey !== cacheProbeKey) {
        cache.set(cacheProbeKey, result, ttl);
      }
    }

    if (result.status === "ok" && Number(result.confidence) >= request.minConfidence) {
      return { result, backend };
    }
    if (result.status === "degraded" && Number(result.confidence) >= request.minConfidence) {
      degradedCandidates.push({ result, backend });
    }
  }
  if (request.allowDegraded && degradedCandidates.length) {
    return degradedCandidates[0];
  }
  return {
    result: degradedCandidates[0]?.result || { status: "not_found", confidence: 0 },
    backend: degradedCandidates[0]?.backend,
  };
}

/**
 * Create the OpenClaw `before_prompt_build` hook handler for a runtime.
 * @param {object} runtime Auto-recall runtime from `createRuntime`.
 * @returns {Function} Async OpenClaw hook handler.
 */
export function createBeforePromptBuildHandler(runtime) {
  return async function beforePromptBuild(event = {}, ctx = {}) {
    const { cfg, backends, triggers, cache, inflight, logger } = runtime;
    if (runtime.disposed || runtime.signal?.aborted) {
      return undefined;
    }
    if (!cfg.enabled || !backends.length) {
      return undefined;
    }
    const ok = eligible(ctx, event, cfg);
    if (!ok.ok) {
      return undefined;
    }

    const original = event.prompt || event.text || event.message || "";
    if (!original || hasActiveMemoryMarker(original) || isSyntheticOrInternalEnvelope(original)) {
      return undefined;
    }
    const text = stripEnvelope(original).slice(0, cfg.recallMaxChars);
    if (text.length < cfg.recallMinChars || isInternalPrompt(text, triggers.getSnapshot())) {
      return undefined;
    }

    const triggerSnapshot = triggers.getSnapshot();
    const trigger = getRecallTrigger(text, triggerSnapshot);
    if (!trigger.match) {
      return undefined;
    }

    const parentSignal = ctx?.signal || event?.signal;
    const { signal, cleanup } = timeoutController([runtime.signal, parentSignal], cfg.timeoutMs);
    try {
      const request = {
        text,
        normalizedText: normalizeCacheText(text),
        trigger: { patternId: trigger.patternId, matchedText: trigger.matchedText },
        maxResults: cfg.maxResults,
        minConfidence: cfg.minConfidence,
        allowDegraded: cfg.allowDegraded,
        timeoutMs: cfg.timeoutMs,
        signal,
        locale: undefined,
        session: {
          agentId: ok.agentId,
          provider: ok.provider,
          chatType: ok.chatType,
          sessionKey: ok.sessionKey,
        },
      };
      const { result, backend, cached } = await runBackendChain({
        backends,
        request,
        cache,
        inflight,
        logger,
      });
      if (!result || result.status === "not_found" || result.status === "error") {
        return undefined;
      }
      if (result.status === "degraded" && !cfg.allowDegraded) {
        return undefined;
      }
      if (Number(result.confidence) < cfg.minConfidence) {
        return undefined;
      }
      const injection = buildInjection(result, cfg.injection);
      if (!injection) {
        return undefined;
      }
      logger.info({
        event: "injected",
        backend: backend?.name,
        cached: Boolean(cached),
        confidence: result.confidence,
        status: result.status,
        trigger: trigger.patternId,
      });
      return { prependContext: injection };
    } catch (error) {
      logger.warn({ event: "exception", error: error?.message || String(error) });
      return undefined;
    } finally {
      cleanup();
    }
  };
}

/**
 * Create plugin runtime state, including config, backends, cache, and triggers.
 * @param {object} [pluginConfig={}] Raw plugin configuration.
 * @param {{info?: Function, warn?: Function}} [apiLogger=console] Host logger.
 * @returns {object} Runtime with `dispose`.
 */
export function createRuntime(pluginConfig = {}, apiLogger = console) {
  const cfg = normalizeConfig(pluginConfig);
  const logger = createLogger({ logPath: cfg.logPath, consoleLogger: apiLogger });
  const triggers = createTriggerManager({
    customPath: cfg.triggers.customPath,
    reloadSignal: cfg.triggers.reloadSignal,
    logger,
  });
  const controller = new AbortController();
  let backends = [];
  backends = createBackends(cfg, logger);
  const runtime = {
    cfg,
    logger,
    triggers,
    backends,
    cache: new RecallCache(cfg.cache),
    inflight: new InflightDeduper(),
    signal: controller.signal,
    disposed: false,
    dispose: async () => {
      runtime.disposed = true;
      controller.abort(new Error("disposed"));
      triggers.dispose();
      await Promise.allSettled(backends.map((backend) => backend.dispose?.()));
    },
  };
  return runtime;
}

/** OpenClaw plugin entry point. */
export const plugin = {
  id: "auto-recall",
  name: "Auto Recall",
  description:
    "Triggers recall backends from user questions and injects relevant memory into the prompt.",
  register(api) {
    const runtime = createRuntime(api.pluginConfig || {}, api.logger || console);
    if (!runtime.cfg.enabled) {
      api.logger?.info?.("auto-recall: disabled");
      return () => {
        void runtime.dispose();
      };
    }
    const unsubscribe = api.on("before_prompt_build", createBeforePromptBuildHandler(runtime));
    return () => {
      if (typeof unsubscribe === "function") {
        unsubscribe();
      }
      void runtime.dispose();
    };
  },
};

export {
  deriveChatType,
  getRecallTrigger,
  hasActiveMemoryMarker,
  isInternalPrompt,
  isSyntheticOrInternalEnvelope,
  normalizeCacheText,
  stripEnvelope,
};
