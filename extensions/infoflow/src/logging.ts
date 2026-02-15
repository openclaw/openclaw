/**
 * Structured logging module for Infoflow extension.
 * Provides consistent logging interface across all Infoflow modules.
 */

import type { RuntimeLogger } from "openclaw/plugin-sdk";
import { getInfoflowRuntime } from "./runtime.js";

// ---------------------------------------------------------------------------
// Logger Factory
// ---------------------------------------------------------------------------

/**
 * Creates a child logger with infoflow-specific bindings.
 * Uses the PluginRuntime logging system for structured output.
 */
function createInfoflowLogger(module?: string): RuntimeLogger {
  const runtime = getInfoflowRuntime();
  const bindings: Record<string, unknown> = { subsystem: "gateway/channels/infoflow" };
  if (module) {
    bindings.module = module;
  }
  return runtime.logging.getChildLogger(bindings);
}

// ---------------------------------------------------------------------------
// Module-specific Loggers (lazy initialization)
// ---------------------------------------------------------------------------

let _sendLog: RuntimeLogger | null = null;
let _webhookLog: RuntimeLogger | null = null;
let _botLog: RuntimeLogger | null = null;
let _parseLog: RuntimeLogger | null = null;

/**
 * Logger for send operations (private/group message sending).
 */
export function getInfoflowSendLog(): RuntimeLogger {
  if (!_sendLog) {
    _sendLog = createInfoflowLogger("send");
  }
  return _sendLog;
}

/**
 * Logger for webhook/monitor operations.
 */
export function getInfoflowWebhookLog(): RuntimeLogger {
  if (!_webhookLog) {
    _webhookLog = createInfoflowLogger("webhook");
  }
  return _webhookLog;
}

/**
 * Logger for bot/message processing operations.
 */
export function getInfoflowBotLog(): RuntimeLogger {
  if (!_botLog) {
    _botLog = createInfoflowLogger("bot");
  }
  return _botLog;
}

/**
 * Logger for request parsing operations.
 */
export function getInfoflowParseLog(): RuntimeLogger {
  if (!_parseLog) {
    _parseLog = createInfoflowLogger("parse");
  }
  return _parseLog;
}

// ---------------------------------------------------------------------------
// Utility Functions
// ---------------------------------------------------------------------------

/**
 * Format error message for logging.
 */
export function formatInfoflowError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

/**
 * Log an API error with operation context.
 * @param operation - The API operation name (e.g., "sendPrivate", "getToken")
 * @param error - The error to log
 * @param logger - Optional logger to use (defaults to send logger)
 */
export function logInfoflowApiError(
  operation: string,
  error: unknown,
  logger?: RuntimeLogger,
): void {
  const log = logger ?? getInfoflowSendLog();
  const errMsg = formatInfoflowError(error);
  log.error(`[infoflow:${operation}] ${errMsg}`);
}

// ---------------------------------------------------------------------------
// Test-only exports (@internal)
// ---------------------------------------------------------------------------

/** @internal — Reset all cached loggers. Only use in tests. */
export function _resetLoggers(): void {
  _sendLog = null;
  _webhookLog = null;
  _botLog = null;
  _parseLog = null;
}
