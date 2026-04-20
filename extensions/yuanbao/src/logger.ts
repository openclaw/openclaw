/** Yuanbao plugin shared logging module. */

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
  info: (msg, meta) => console.log(`${LOG_PREFIX} ${msg}`, meta ?? ""),
  warn: (msg, meta) => console.warn(`${LOG_PREFIX} ${msg}`, meta ?? ""),
  error: (msg, meta) => console.error(`${LOG_PREFIX} ${msg}`, meta ?? ""),
  debug: (msg, meta) => console.debug(`${LOG_PREFIX} ${msg}`, meta ?? ""),
};

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

function getActiveLogger(): PluginLogger {
  return initialized && childLogger ? childLogger : fallbackLogger;
}

export const logger: PluginLogger = {
  info: (msg, meta) => getActiveLogger().info(msg, meta),
  warn: (msg, meta) => getActiveLogger().warn(msg, meta),
  error: (msg, meta) => getActiveLogger().error(msg, meta),
  debug: (msg, meta) => getActiveLogger().debug(msg, meta),
};

export function isVerbose(): boolean {
  return verboseEnabled;
}

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

const debugBotIds = new Set<string>(parseEnvDebugBotIds());

export function setDebugBotIds(ids: string[]): void {
  debugBotIds.clear();
  for (const id of [...parseEnvDebugBotIds(), ...ids]) {
    const trimmed = id.trim();
    if (trimmed) {
      debugBotIds.add(trimmed);
    }
  }
}

export function isDebugBotId(botId?: string): boolean {
  return botId ? debugBotIds.has(botId) : false;
}

export interface LogSink {
  info?: (msg: string) => void;
  warn?: (msg: string) => void;
  error?: (msg: string) => void;
  debug?: (msg: string) => void;
  verbose?: (msg: string) => void;
}

export interface ModuleLog {
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
  debug(msg: string, data?: Record<string, unknown>): void;
}

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
  return `${prefix} ${msg} ${skipSanitize ? JSON.stringify(data) : sanitize(data)}`;
}

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

const OMIT_KEYS = new Set(["msg_body"]);

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

function maskValue(value: string): string {
  if (value.length < 8) {
    return "***";
  }
  return `${value.slice(0, 3)}****${value.slice(-3)}`;
}

export function sanitize(value: unknown): string {
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === "object" && parsed !== null) {
        return JSON.stringify(sanitizeObj(parsed as Record<string, unknown>));
      }
    } catch {
      /* not JSON */
    }
    return value;
  }
  if (typeof value === "object") {
    return JSON.stringify(sanitizeObj(value as Record<string, unknown>));
  }
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
