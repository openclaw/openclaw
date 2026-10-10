/** Shared bounded pagination for MCP list operations. */
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";

type McpPaginationPage<T> = {
  items: readonly T[];
  nextCursor?: string;
  /** Original SDK page used for the aggregate serialized-byte budget. */
  serializedValue?: unknown;
};

type McpPaginationRequest = {
  cursor: string | undefined;
  /**
   * Full per-request safety budget. The collector signal owns the absolute list deadline,
   * so nested transport timers cannot replace its canonical timeout error.
   */
  requestTimeoutMs: number;
  signal: AbortSignal;
};

type CollectMcpPaginatedItemsParams<T> = {
  label: string;
  itemLabel: string;
  timeoutMs: number;
  maxPages: number;
  maxItems: number;
  maxBytes: number;
  signal?: AbortSignal;
  loadPage: (request: McpPaginationRequest) => Promise<McpPaginationPage<T>>;
};

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive safe integer`);
  }
  return value;
}

function abortError(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`);
}

/** Collects one complete MCP list under a single bounded lifecycle. */
export async function collectMcpPaginatedItems<T>(
  params: CollectMcpPaginatedItemsParams<T>,
): Promise<T[]> {
  const timeoutMs = clampPositiveTimerTimeoutMs(params.timeoutMs);
  if (timeoutMs === undefined) {
    throw new Error(`${params.label} requires a positive timeout`);
  }
  const maxPages = positiveInteger(params.maxPages, `${params.label} maxPages`);
  const maxItems = positiveInteger(params.maxItems, `${params.label} maxItems`);
  const maxBytes = positiveInteger(params.maxBytes, `${params.label} maxBytes`);

  const deadlineController = new AbortController();
  const signal = params.signal
    ? AbortSignal.any([params.signal, deadlineController.signal])
    : deadlineController.signal;
  if (signal.aborted) {
    throw abortError(signal, params.label);
  }
  const deadlineAtMs = performance.now() + timeoutMs;
  const timeoutError = new Error(`${params.label} timed out after ${timeoutMs}ms`);
  const deadlineTimer = setTimeout(() => deadlineController.abort(timeoutError), timeoutMs);
  deadlineTimer.unref?.();
  const assertActive = () => {
    if (signal.aborted) {
      throw abortError(signal, params.label);
    }
    if (performance.now() >= deadlineAtMs) {
      deadlineController.abort(timeoutError);
      throw timeoutError;
    }
  };

  const items: T[] = [];
  const seenCursors = new Set<string>();
  let collectedBytes = 0;
  let cursor: string | undefined;

  try {
    for (let pageNumber = 0; pageNumber < maxPages; pageNumber += 1) {
      assertActive();
      const page = await racePromiseWithAbortSignal(
        params.loadPage({ cursor, requestTimeoutMs: timeoutMs, signal }),
        signal,
        () => abortError(signal, params.label),
      );
      assertActive();
      const measured = boundedJsonUtf8Bytes(
        page.serializedValue ?? { items: page.items, nextCursor: page.nextCursor },
        maxBytes - collectedBytes,
      );
      if (!measured.complete || collectedBytes + measured.bytes > maxBytes) {
        throw new Error(`${params.label} exceeded ${maxBytes} bytes`);
      }
      collectedBytes += measured.bytes;

      for (const item of page.items) {
        if (item === undefined) {
          continue;
        }
        if (items.length >= maxItems) {
          throw new Error(`${params.label} exceeded ${maxItems} ${params.itemLabel}`);
        }
        items.push(item);
      }

      // Synchronous page processing can consume the deadline or abort its caller.
      // Never accept either a terminal page or its continuation after ownership ends.
      const nextCursor = page.nextCursor;
      assertActive();
      if (nextCursor === undefined) {
        return items;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(`${params.label} returned a repeated pagination cursor`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error(`${params.label} exceeded ${maxPages} pages`);
  } finally {
    clearTimeout(deadlineTimer);
  }
}
