/**
 * QQBot 调试日志工具。
 *
 * Only outputs when the QQBOT_DEBUG environment variable is set,
 * preventing user message content from leaking in production logs.
 *
 * Self-contained within engine/ — no framework SDK dependency.
 */

const isDebug = () => !!process.env.QQBOT_DEBUG;

/** 调试级别日志，仅在 QQBOT_DEBUG 开启时输出。 */
export function debugLog(...args: unknown[]): void {
  if (isDebug()) {
    console.log(...args);
  }
}

/** 调试级别警告，仅在 QQBOT_DEBUG 开启时输出。 */
export function debugWarn(...args: unknown[]): void {
  if (isDebug()) {
    console.warn(...args);
  }
}

/** 调试级别错误，仅在 QQBOT_DEBUG 开启时输出。 */
export function debugError(...args: unknown[]): void {
  if (isDebug()) {
    console.error(...args);
  }
}
