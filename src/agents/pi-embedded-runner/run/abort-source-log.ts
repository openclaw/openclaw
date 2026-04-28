import { isTruthyEnvValue } from "../../../infra/env.js";
import { log } from "../logger.js";

export type AbortSource =
  | "external-signal"
  | "llm-idle-timeout"
  | "compaction-timeout"
  | "run-timer"
  | "explicit-cancel";

export interface AbortSourceContext {
  runId: string;
  sessionId: string;
  isTimeout: boolean;
  externalAbort: boolean;
  idleTimedOut: boolean;
  timedOutDuringCompaction: boolean;
  reason: unknown;
}

export function isAbortSourceLoggingEnabled(): boolean {
  return isTruthyEnvValue(process.env.OPENCLAW_LOG_ABORT_SOURCES);
}

export function classifyAbortSource(ctx: AbortSourceContext): AbortSource {
  if (ctx.externalAbort) return "external-signal";
  if (ctx.idleTimedOut) return "llm-idle-timeout";
  if (ctx.timedOutDuringCompaction) return "compaction-timeout";
  if (ctx.isTimeout) return "run-timer";
  return "explicit-cancel";
}

function formatReason(reason: unknown): string {
  if (reason === undefined) return "<none>";
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function captureCallerStack(): string {
  // Frames: [0] "Error", [1] captureCallerStack, [2] logAbortSource, [3..] caller chain.
  const stack = new Error().stack;
  if (!stack) return "<unavailable>";
  return stack
    .split("\n")
    .slice(3, 8)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" | ");
}

/**
 * Emit a structured log line describing the cause of a mid-run abort.
 *
 * Gated by `OPENCLAW_LOG_ABORT_SOURCES=1` so production logs stay clean.
 * The category + caller stack lets operators distinguish an external
 * AbortSignal from internal run/idle/compaction timers when triaging
 * mysterious mid-stream cutoffs that surface only as a generic AbortError.
 */
export function logAbortSource(ctx: AbortSourceContext): void {
  if (!isAbortSourceLoggingEnabled()) return;
  const source = classifyAbortSource(ctx);
  const stack = captureCallerStack();
  log.warn(
    `[abort-source] runId=${ctx.runId} sessionId=${ctx.sessionId} ` +
      `source=${source} isTimeout=${ctx.isTimeout} ` +
      `idleTimeout=${ctx.idleTimedOut} compactionTimeout=${ctx.timedOutDuringCompaction} ` +
      `external=${ctx.externalAbort} reason=${formatReason(ctx.reason)} stack=${stack}`,
  );
}
