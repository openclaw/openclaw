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

export type FormatErrorOptions = {
  /** Include stack trace in the output (default: false) */
  includeStack?: boolean;
};

/**
 * Format error message for logging.
 * @param err - The error to format
 * @param options - Formatting options
 */
export function formatInfoflowError(err: unknown, options?: FormatErrorOptions): string {
  if (err instanceof Error) {
    if (options?.includeStack && err.stack) {
      return err.stack;
    }
    return err.message;
  }
  return String(err);
}

export type LogApiErrorOptions = {
  /** Logger to use (defaults to send logger) */
  logger?: RuntimeLogger;
  /** Include stack trace in the log (default: false) */
  includeStack?: boolean;
};

/**
 * Log an API error with operation context and structured metadata.
 * @param operation - The API operation name (e.g., "sendPrivate", "getToken")
 * @param error - The error to log
 * @param options - Logging options
 */
export function logInfoflowApiError(
  operation: string,
  error: unknown,
  options?: LogApiErrorOptions | RuntimeLogger,
): void {
  // Support legacy signature: logInfoflowApiError(op, err, logger)
  const opts: LogApiErrorOptions =
    options && "error" in options ? { logger: options as RuntimeLogger } : (options ?? {});

  const log = opts.logger ?? getInfoflowSendLog();
  const errMsg = formatInfoflowError(error, { includeStack: opts.includeStack });

  // Use structured meta for better log aggregation and filtering
  log.error(`[infoflow:${operation}] ${errMsg}`, {
    operation,
    errorType: error instanceof Error ? error.constructor.name : typeof error,
  });
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
