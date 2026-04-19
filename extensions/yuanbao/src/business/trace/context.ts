import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomBytes } from "node:crypto";
import { createLog } from "../../logger.js";

export type YuanbaoTraceContext = {
  traceId: string;
  traceparent: string;
  seqId?: string;
  /** Auto-incremented based on inbound seqId */
  nextMsgSeq: () => number | undefined;
};

const traceStorage = new AsyncLocalStorage<YuanbaoTraceContext>();
const EMPTY_TRACE_ID = "0".repeat(32);

function generateHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/**
 * Generate a random trace ID (32-char hex string).
 * Used as fallback when inbound message has no trace_id.
 */ export function generateTraceId(): string {
  return generateHex(16);
}

function normalizeTraceIdForTraceparent(traceId: string): string {
  const normalized = traceId
    .trim()
    .toLowerCase()
    .replace(/[^0-9a-f]/g, "");
  if (normalized.length >= 32) {
    const candidate = normalized.slice(0, 32);
    if (candidate !== EMPTY_TRACE_ID) {
      return candidate;
    }
  }

  const hashed = createHash("sha256").update(traceId.trim()).digest("hex").slice(0, 32);
  if (hashed !== EMPTY_TRACE_ID) {
    return hashed;
  }

  return generateTraceId();
}

function buildTraceparent(traceId: string): string {
  return `00-${normalizeTraceIdForTraceparent(traceId)}-${generateHex(8)}-01`;
}

function normalizeSeqId(seqId?: string | number): string | undefined {
  if (seqId === undefined || seqId === null) {
    return undefined;
  }
  const normalized = String(seqId).trim();
  return normalized || undefined;
}

/**
 * Resolve or generate a complete trace context.
 * Prefers inbound traceId; generates one if missing.
 * Also parses the associated seq_id.
 */
export function resolveTraceContext(params: {
  traceId?: string;
  seqId?: string | number;
}): YuanbaoTraceContext {
  const incomingTraceId = params.traceId?.trim();
  const traceId = incomingTraceId || generateTraceId();
  const seqId = normalizeSeqId(params.seqId);

  const baseSeq = seqId ? parseInt(seqId, 10) : NaN;
  let seqCounter = 0;
  const nextMsgSeq = (): number | undefined => {
    if (Number.isNaN(baseSeq)) {
      return undefined;
    }
    seqCounter++;
    return baseSeq + seqCounter;
  };

  const log = createLog("trace");
  log.debug("[msg-trace] resolve context", {
    traceId,
    generated: !incomingTraceId,
    seqId: seqId ?? "(none)",
  });

  return {
    traceId,
    traceparent: buildTraceparent(traceId),
    nextMsgSeq,
    ...(seqId ? { seqId } : {}),
  };
}

/**
 * Get the trace context from the current async context (via AsyncLocalStorage).
 */
export function getActiveTraceContext(): YuanbaoTraceContext | undefined {
  return traceStorage.getStore();
}

/**
 * Run an async callback within the given trace context.
 * Inside the callback (and all spawned async ops), the context is available
 * via {@link getActiveTraceContext}, and the fetch interceptor auto-injects X-Traceparent.
 */
export function runWithTraceContext<T>(
  traceContext: YuanbaoTraceContext,
  callback: () => Promise<T>,
): Promise<T> {
  return traceStorage.run(traceContext, callback);
}
