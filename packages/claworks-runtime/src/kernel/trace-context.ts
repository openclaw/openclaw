import { randomBytes } from "node:crypto";

const TRACEPARENT_VERSION = "00";
const DEFAULT_TRACE_FLAGS = "01";
const MAX_TRACEPARENT_LENGTH = 128;
const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/;
const TRACEPARENT_VERSION_RE = /^[0-9a-f]{2}$/;

export type TraceContext = {
  /** W3C trace id, 32 lowercase hex chars. */
  readonly traceId: string;
  /** Current span id, 16 lowercase hex chars. */
  readonly spanId: string;
  /** W3C trace flags, 2 lowercase hex chars. Defaults to sampled. */
  readonly traceFlags: string;
};

function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

function isNonZeroHex(value: string): boolean {
  return !/^0+$/.test(value);
}

function randomTraceId(): string {
  let traceId = randomHex(16);
  while (!isNonZeroHex(traceId)) {
    traceId = randomHex(16);
  }
  return traceId;
}

function randomSpanId(): string {
  let spanId = randomHex(8);
  while (!isNonZeroHex(spanId)) {
    spanId = randomHex(8);
  }
  return spanId;
}

function normalizeTraceId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return TRACE_ID_RE.test(normalized) && isNonZeroHex(normalized) ? normalized : undefined;
}

function normalizeSpanId(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return SPAN_ID_RE.test(normalized) && isNonZeroHex(normalized) ? normalized : undefined;
}

function normalizeTraceFlags(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const normalized = value.toLowerCase();
  return TRACE_FLAGS_RE.test(normalized) ? normalized : undefined;
}

export function parseTraceparent(traceparent: string | undefined): TraceContext | undefined {
  if (typeof traceparent !== "string" || traceparent.length > MAX_TRACEPARENT_LENGTH) {
    return undefined;
  }
  const parts = traceparent.trim().toLowerCase().split("-");
  if (parts.length < 4) {
    return undefined;
  }
  const [version, traceId, spanId, traceFlags] = parts;
  if (
    !TRACEPARENT_VERSION_RE.test(version) ||
    version === "ff" ||
    (version === TRACEPARENT_VERSION && parts.length !== 4)
  ) {
    return undefined;
  }
  const normalizedTraceId = normalizeTraceId(traceId);
  const normalizedSpanId = normalizeSpanId(spanId);
  const normalizedTraceFlags = normalizeTraceFlags(traceFlags);
  if (!normalizedTraceId || !normalizedSpanId || !normalizedTraceFlags) {
    return undefined;
  }
  return {
    traceId: normalizedTraceId,
    spanId: normalizedSpanId,
    traceFlags: normalizedTraceFlags,
  };
}

export function formatTraceparent(context: TraceContext | undefined): string | undefined {
  if (!context?.spanId) {
    return undefined;
  }
  const traceId = normalizeTraceId(context.traceId);
  const spanId = normalizeSpanId(context.spanId);
  const traceFlags = normalizeTraceFlags(context.traceFlags) ?? DEFAULT_TRACE_FLAGS;
  if (!traceId || !spanId) {
    return undefined;
  }
  return `${TRACEPARENT_VERSION}-${traceId}-${spanId}-${traceFlags}`;
}

export function createRootTraceContext(): TraceContext {
  return {
    traceId: randomTraceId(),
    spanId: randomSpanId(),
    traceFlags: DEFAULT_TRACE_FLAGS,
  };
}

export function createChildTraceContext(parent: TraceContext | string | undefined): TraceContext {
  const parsed = typeof parent === "string" ? parseTraceparent(parent) : parent;
  if (!parsed) {
    return createRootTraceContext();
  }
  return {
    traceId: parsed.traceId,
    spanId: randomSpanId(),
    traceFlags: parsed.traceFlags,
  };
}

export function resolvePublishTraceparent(incoming: string | undefined): string {
  const traceCtx = incoming ? createChildTraceContext(incoming) : createRootTraceContext();
  return formatTraceparent(traceCtx)!;
}
