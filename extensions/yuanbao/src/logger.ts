/**
 * Yuanbao plugin shared logging module.
 *
 * Usage:
 * 1. Call initLogger(api) once during plugin registration.
 * 2. Use the exported convenience methods anywhere:
 *    - logger.info("msg")             // key events
 *    - logger.warn("msg")             // ignorable but noteworthy
 *    - logger.error("msg")            // real errors
 *    - logger.debug("msg")            // debug info (requires --verbose or level=debug)
 *    - logger.info("msg", { k: v })   // with structured meta
 * 3. Falls back to console output before runtime is initialized.
 *
 * Log levels:
 * - info:  key events (startup, message send/receive success)
 * - warn:  ignorable but noteworthy (missing config, skipped processing)
 * - error: real errors (send failure, signature error)
 * - debug: verbose debug info (only visible in verbose mode)
 *
 * View logs:
 * - openclaw logs --follow
 * - openclaw gateway --verbose (shows debug level)
 */

import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { getPluginVersion } from "./infra/env.js";

/** Cached log prefix, refreshed on initLogger */
let LOG_PREFIX = "[yuanbao]";

function refreshLogPrefix(): void {
  const ver = getPluginVersion();
  LOG_PREFIX = ver ? `[yuanbao:${ver}]` : "[yuanbao]";
}

/** Plugin logger interface (compatible with OpenClaw childLogger) */
export interface PluginLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
  debug(message: string, meta?: Record<string, unknown>): void;
}

let childLogger: PluginLogger | null = null;
let initialized = false;
let verboseEnabled = false;

const fallbackLogger: PluginLogger = {
  info(message: string, meta?: Record<string, unknown>): void {
    console.log(`${LOG_PREFIX} ${message}`, meta ?? "");
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    console.warn(`${LOG_PREFIX} ${message}`, meta ?? "");
  },
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`${LOG_PREFIX} ${message}`, meta ?? "");
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    console.debug(`${LOG_PREFIX} ${message}`, meta ?? "");
  },
};

/**
 * Initialize the plugin logger.
 *
 * Called during plugin registration. Creates a child logger tagged with the
 * plugin identifier via the OpenClaw API. After initialization, all exported
 * log methods automatically route to the OpenClaw logger.
 */
export function initLogger(api: OpenClawPluginApi): void {
  try {
    childLogger = api.runtime.logging.getChildLogger({ plugin: "yuanbao" }) as PluginLogger;
    verboseEnabled = api.runtime.logging.shouldLogVerbose?.() ?? false;
    refreshLogPrefix();
    initialized = true;
  } catch (err) {
    console.error(`${LOG_PREFIX} failed to initialize logger, falling back to console`, err);
  }
}

/**
 * Return the currently active logger.
 * Uses the OpenClaw childLogger when initialized; otherwise falls back to console.
 */
function getActiveLogger(): PluginLogger {
  if (initialized && childLogger) {
    const cl = childLogger;
    return {
      info: (message: string, meta?: Record<string, unknown>) =>
        meta ? cl.info(message, meta) : cl.info(message),
      warn: (message: string, meta?: Record<string, unknown>) =>
        meta ? cl.warn(message, meta) : cl.warn(message),
      error: (message: string, meta?: Record<string, unknown>) =>
        meta ? cl.error(message, meta) : cl.error(message),
      debug: (message: string, meta?: Record<string, unknown>) =>
        meta ? cl.debug?.(message, meta) : cl.debug?.(message),
    };
  }
  return fallbackLogger;
}

/**
 * Shared plugin logger instance.
 *
 * @example
 * ```ts
 * import { logger } from "../logger.js";
 *
 * logger.info("plugin loaded");
 * logger.warn("missing config", { key: "appSecret" });
 * logger.error("send failed", { error: err.message });
 * logger.debug("debug info");
 * ```
 */
export const logger: PluginLogger = {
  info(message: string, meta?: Record<string, unknown>): void {
    getActiveLogger().info(message, meta);
  },
  warn(message: string, meta?: Record<string, unknown>): void {
    getActiveLogger().warn(message, meta);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    getActiveLogger().error(message, meta);
  },
  debug(message: string, meta?: Record<string, unknown>): void {
    getActiveLogger().debug(message, meta);
  },
};

/**
 * Check whether verbose mode is enabled.
 *
 * Useful in hot paths to avoid unnecessary string concatenation overhead.
 */
export function isVerbose(): boolean {
  return verboseEnabled;
}

/**
 * Parse debug bot IDs from the YUANBAO_DEBUG_BOT_IDS environment variable.
 * Supports comma-separated values, e.g. YUANBAO_DEBUG_BOT_IDS=bot_aaa,bot_bbb
 */
function parseEnvDebugBotIds(): string[] {
  const raw = process.env.YUANBAO_DEBUG_BOT_IDS;
  if (!raw) {
    return [];
  }
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Bot IDs in the debug whitelist — log sanitization is skipped for these */
const debugBotIds = new Set<string>(parseEnvDebugBotIds());

/**
 * Set the debug whitelist bot IDs.
 *
 * Merges `channels.yuanbao.debugBotIds` from the YAML config with
 * the `YUANBAO_DEBUG_BOT_IDS` environment variable. Logs from
 * whitelisted bot IDs skip sanitization to ease debugging.
 *
 * Typically called from gateway.startAccount after reading the config.
 *
 * @param ids - Bot ID array from the YAML config (merged with env var whitelist)
 */
export function setDebugBotIds(ids: string[]): void {
  debugBotIds.clear();
  for (const id of parseEnvDebugBotIds()) {
    debugBotIds.add(id);
  }
  for (const id of ids) {
    const trimmed = id.trim();
    if (trimmed) {
      debugBotIds.add(trimmed);
    }
  }
}

/**
 * Check whether a bot ID is in the debug whitelist.
 *
 * @param botId - Bot ID to check; returns false when empty
 */
export function isDebugBotId(botId?: string): boolean {
  if (!botId) {
    return false;
  }
  return debugBotIds.has(botId);
}

/** Generic log sink interface — compatible with the logger singleton, ctx.log, and pass-through GatewayLog */
export interface LogSink {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
  verbose?: (msg: string) => void;
}

/** Unified log interface returned by createLog */
export interface ModuleLog {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

/**
 * Format a log message: prefix with LOG_PREFIX + module, auto-sanitize data.
 *
 * @param module - Module identifier (e.g. 'ws', 'inbound', accountId)
 * @param msg - Log message body
 * @param data - Optional structured data (auto-sanitized unless skipSanitize is set)
 * @param skipSanitize - When true, skip sanitization and use raw JSON.stringify
 * @returns Formatted log string
 */
export function formatLog(
  module: string,
  msg: string,
  data?: Record<string, unknown>,
  skipSanitize?: boolean,
): string {
  const prefix = module ? `${LOG_PREFIX}[${module}]` : LOG_PREFIX;
  if (data === undefined) {
    return `${prefix} ${msg}`;
  }
  const serialized = skipSanitize ? JSON.stringify(data) : sanitize(data);
  return `${prefix} ${msg} ${serialized}`;
}

/**
 * Create a module-scoped log helper.
 *
 * Automatically prefixes messages with LOG_PREFIX[module], sanitizes data,
 * and adapts to any log sink.
 *
 * @param module - Module identifier (e.g. 'ws', 'inbound', 'outbound', accountId)
 * @param sink - Log output target; defaults to the shared logger singleton
 * @returns Module log with info/warn/error/debug methods
 *
 * @example
 * ```ts
 * const log = createLog('inbound', ctx.log);
 * log.info('received message', { from: userId });
 * log.error('processing failed', { error: String(err) });
 * ```
 */
export function createLog(module: string, sink?: LogSink, options?: { botId?: string }): ModuleLog {
  const target = sink ?? logger;
  const skipSanitize = isDebugBotId(options?.botId);

  function fmt(msg: string, data?: Record<string, unknown>): string {
    return formatLog(module, msg, data, skipSanitize);
  }

  return {
    info: (msg, data) => target.info?.(fmt(msg, data)),
    warn: (msg, data) => target.warn?.(fmt(msg, data)),
    error: (msg, data) => target.error?.(fmt(msg, data)),
    debug: (msg, data) => (target.debug ?? (target as LogSink).verbose)?.(fmt(msg, data)),
  };
}

/** Field names to omit entirely from log output */
const OMIT_KEYS = new Set(["msg_body"]);

/** Sensitive field names to mask in log output */
const SENSITIVE_KEYS = new Set([
  "token",
  "signature",
  "app_key",
  "appkey",
  "appsecret",
  "app_secret",
  "secret",
  "password",
  "x-token",
  "user_input",
  "cloud_custom_data",
  "model_output",
]);

/**
 * Mask a string value, keeping the first and last 3 characters.
 * Strings shorter than 8 characters are fully masked.
 *
 * @example maskValue("abcdefghij") => "abc****hij"
 */
function maskValue(value: string): string {
  if (value.length < 8) {
    return "***";
  }
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
}

/**
 * Sanitize sensitive fields before writing to logs.
 * Accepts objects, JSON strings, or primitive types.
 *
 * - Objects/arrays: recursively mask sensitive field values
 * - JSON strings: parse → sanitize → re-serialize
 * - Other types: return as-is
 *
 * @param value - Value to sanitize (object, JSON string, or primitive)
 * @returns Sanitized string representation
 */
export function sanitize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value === "string") {
    // Try parsing JSON strings to sanitize inner fields
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(sanitizeObj(parsed as Record<string, unknown>));
      }
    } catch {
      // Not a JSON string — return as-is
    }
    return value;
  }

  if (typeof value === "object") {
    return JSON.stringify(sanitizeObj(value as Record<string, unknown>));
  }

  // Primitives (number / boolean / bigint / symbol / function)
  return typeof value === "symbol"
    ? value.toString()
    : String(value as string | number | boolean | bigint);
}

function sanitizeObj(obj: Record<string, unknown>): Record<string, unknown> {
  if (Array.isArray(obj)) {
    return obj.map((item) =>
      typeof item === "object" && item !== null ? sanitizeObj(item) : item,
    ) as unknown as Record<string, unknown>;
  }

  const result: Record<string, unknown> = {};

  for (const [key, val] of Object.entries(obj)) {
    if (OMIT_KEYS.has(key.toLowerCase())) {
      continue;
    }
    if (SENSITIVE_KEYS.has(key.toLowerCase()) && typeof val === "string") {
      result[key] = maskValue(val);
    } else if (typeof val === "object" && val !== null) {
      result[key] = sanitizeObj(val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }

  return result;
}
