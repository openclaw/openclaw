/**
 * QQBot debug logging utilities.
 * QQBot 调试日志工具。
 *
 * Only outputs when the QQBOT_DEBUG environment variable is set,
 * preventing user message content from leaking in production logs.
 *
 * Self-contained within engine/ — no framework SDK dependency.
 */

const isDebug = () => !!process.env.QQBOT_DEBUG;
const MAX_LOG_VALUE_CHARS = 4096;

export function sanitizeDebugLogValue(value: unknown): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else if (value instanceof Error) {
    text = value.stack || value.message;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }

  const sanitized = text
    .replace(/\p{Cc}/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (sanitized.length <= MAX_LOG_VALUE_CHARS) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_LOG_VALUE_CHARS)}...`;
}

function sanitizeDebugLogArgs(args: unknown[]): string[] {
  return args.map(sanitizeDebugLogValue);
}

/** Debug-level log; only outputs when QQBOT_DEBUG is enabled. */
export function debugLog(...args: unknown[]): void {
  if (isDebug()) {
    console.log(...sanitizeDebugLogArgs(args));
  }
}

/** Debug-level warning; only outputs when QQBOT_DEBUG is enabled. */
export function debugWarn(...args: unknown[]): void {
  if (isDebug()) {
    console.warn(...sanitizeDebugLogArgs(args));
  }
}

/** Debug-level error; only outputs when QQBOT_DEBUG is enabled. */
export function debugError(...args: unknown[]): void {
  if (isDebug()) {
    console.error(...sanitizeDebugLogArgs(args));
  }
}
