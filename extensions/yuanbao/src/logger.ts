/** Yuanbao plugin shared logging module. Falls back to console before runtime init. */

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
 * Initialize the plugin logger (called during plugin registration).
 * Creates a child logger tagged with the plugin identifier via the OpenClaw API.
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

/** Return the currently active logger (childLogger when initialized, otherwise console fallback). */
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

/** Shared plugin logger instance. */
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

/** Check whether verbose mode is enabled. Useful to avoid unnecessary string concatenation in hot paths. */
export function isVerbose(): boolean {
  return verboseEnabled;
}

/** Parse debug bot IDs from the YUANBAO_DEBUG_BOT_IDS environment variable. */
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
 * Merges YAML config `debugBotIds` with `YUANBAO_DEBUG_BOT_IDS` env var.
 * Whitelisted bot IDs skip log sanitization.
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

/** Check whether a bot ID is in the debug whitelist. */
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

/** Format a log message with LOG_PREFIX + module, auto-sanitizing data. */
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

/** Create a module-scoped log helper with auto-prefix and sanitization. */
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

/** Mask a string value, keeping the first and last 3 characters. Strings < 8 chars are fully masked. */
function maskValue(value: string): string {
  if (value.length < 8) {
    return "***";
  }
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
}

/** Sanitize sensitive fields before writing to logs. Accepts objects, JSON strings, or primitives. */
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
