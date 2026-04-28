import path from "node:path";
import { HttpBackend } from "./backends/http.js";
import { ScriptBackend } from "./backends/script.js";

/** Default auto-recall plugin configuration. */
export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  agents: [],
  allowedChatTypes: ["direct", "group"],
  timeoutMs: 7000,
  maxResults: 5,
  minConfidence: 0.4,
  allowDegraded: false,
  logPath: undefined,
  recallMinChars: 8,
  recallMaxChars: 8000,
  triggers: { customPath: undefined, reloadSignal: "SIGUSR2" },
  cache: {
    enabled: true,
    okTtlMs: 30 * 60_000,
    notFoundTtlMs: 10 * 60_000,
    degradedTtlMs: 30 * 60_000,
    errorTtlMs: 0,
    maxEntries: 500,
  },
  injection: { maxLength: 2000, tag: "active_memory", includeSources: true },
  backends: [],
});

function int(value, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : fallback;
}

function num(value, fallback, min = 0, max = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function strArray(value, fallback = []) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : fallback;
}

function object(value, fallback = {}) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : fallback;
}

/**
 * Normalize user-provided plugin configuration into bounded runtime settings.
 * @param {unknown} raw Raw plugin configuration.
 * @returns {object} Normalized configuration.
 */
export function normalizeConfig(raw = {}) {
  const c = raw && typeof raw === "object" ? raw : {};
  const cache = { ...DEFAULT_CONFIG.cache, ...object(c.cache) };
  const injection = { ...DEFAULT_CONFIG.injection, ...object(c.injection) };
  const triggers = { ...DEFAULT_CONFIG.triggers, ...object(c.triggers) };
  const reloadSignal =
    triggers.reloadSignal === false
      ? false
      : typeof triggers.reloadSignal === "string" && triggers.reloadSignal.trim()
        ? triggers.reloadSignal.trim()
        : DEFAULT_CONFIG.triggers.reloadSignal;
  return {
    enabled: c.enabled !== false,
    agents: strArray(c.agents, DEFAULT_CONFIG.agents),
    allowedChatTypes: strArray(c.allowedChatTypes, DEFAULT_CONFIG.allowedChatTypes),
    timeoutMs: int(c.timeoutMs, DEFAULT_CONFIG.timeoutMs, 100, 60_000),
    maxResults: int(c.maxResults, DEFAULT_CONFIG.maxResults, 1, 50),
    minConfidence: num(c.minConfidence, DEFAULT_CONFIG.minConfidence),
    allowDegraded: Boolean(c.allowDegraded),
    logPath:
      typeof c.logPath === "string" && c.logPath.trim() ? path.resolve(c.logPath) : undefined,
    recallMinChars: int(c.recallMinChars, DEFAULT_CONFIG.recallMinChars, 1, 50_000),
    recallMaxChars: int(c.recallMaxChars, DEFAULT_CONFIG.recallMaxChars, 100, 100_000),
    triggers: {
      customPath:
        typeof triggers.customPath === "string" && triggers.customPath.trim()
          ? path.resolve(triggers.customPath)
          : undefined,
      reloadSignal,
    },
    cache: {
      enabled: cache.enabled !== false,
      okTtlMs: int(cache.okTtlMs ?? cache.successTtlMs, DEFAULT_CONFIG.cache.okTtlMs, 0),
      notFoundTtlMs: int(
        cache.notFoundTtlMs ?? cache.negativeTtlMs,
        DEFAULT_CONFIG.cache.notFoundTtlMs,
        0,
      ),
      degradedTtlMs: int(
        cache.degradedTtlMs,
        cache.okTtlMs ?? cache.successTtlMs ?? DEFAULT_CONFIG.cache.degradedTtlMs,
        0,
      ),
      errorTtlMs: int(cache.errorTtlMs, DEFAULT_CONFIG.cache.errorTtlMs, 0),
      maxEntries: int(cache.maxEntries, DEFAULT_CONFIG.cache.maxEntries, 1, 50_000),
    },
    injection: {
      maxLength: int(injection.maxLength, DEFAULT_CONFIG.injection.maxLength, 100, 50_000),
      tag:
        typeof injection.tag === "string" && /^[a-zA-Z][a-zA-Z0-9_-]*$/.test(injection.tag)
          ? injection.tag
          : DEFAULT_CONFIG.injection.tag,
      includeSources: injection.includeSources !== false,
    },
    backends: Array.isArray(c.backends) ? c.backends : [],
  };
}

/**
 * Instantiate configured backends while skipping malformed entries.
 * @param {{backends: Array<object>}} config Normalized plugin configuration.
 * @param {{warn?: Function}} [logger] Logger used for backend configuration failures.
 * @returns {Array<object>} Backend instances.
 */
export function createBackends(config, logger) {
  const backends = [];
  for (const [index, backend] of config.backends.entries()) {
    try {
      if (!backend || typeof backend !== "object") {
        throw new Error(`backend ${index} must be an object`);
      }
      if (backend.type === "http") {
        backends.push(new HttpBackend(backend));
      } else if (backend.type === "script") {
        backends.push(new ScriptBackend(backend));
      } else {
        throw new Error(`unsupported backend type: ${backend.type}`);
      }
    } catch (error) {
      logger?.warn?.({
        event: "backend_config_failed",
        index,
        error: error?.message || String(error),
      });
    }
  }
  return backends;
}

/**
 * Infer OpenClaw chat type from hook context or event metadata.
 * @param {object} [ctx={}] Hook context.
 * @param {object} [event={}] Hook event.
 * @returns {string|null} `direct`, `group`, or null when unknown/unsupported.
 */
export function deriveChatType(ctx = {}, event = {}) {
  if (typeof ctx.chatType === "string") {
    return ctx.chatType;
  }
  if (typeof event.chatType === "string") {
    return event.chatType;
  }
  const key = ctx.sessionKey || event.sessionKey || event?.metadata?.sessionKey || "";
  if (/:group:/i.test(key)) {
    return "group";
  }
  if (/:direct:/i.test(key)) {
    return "direct";
  }
  if (ctx.messageProvider && ctx.messageProvider !== "telegram") {
    return null;
  }
  return null;
}
