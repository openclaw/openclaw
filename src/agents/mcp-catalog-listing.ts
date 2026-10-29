import type { Client, Prompt, Resource, Tool } from "@modelcontextprotocol/client";
import {
  asPositiveFiniteNumber,
  clampPositiveTimerTimeoutMs,
} from "@openclaw/normalization-core/number-coercion";
import { asOptionalObjectRecord } from "@openclaw/normalization-core/record-coerce";
import { racePromiseWithAbortSignal } from "../infra/abort-signal.js";
import { boundedJsonUtf8Bytes } from "../infra/json-utf8-bytes.js";

const MCP_CATALOG_MAX_PAGES = 128;
const MCP_CATALOG_MAX_ITEMS = 16_384;
const MCP_CATALOG_MAX_BYTES = 10 * 1024 * 1024;

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
  signal?: AbortSignal;
  loadPage: (request: McpPaginationRequest) => Promise<McpPaginationPage<T>>;
};

function abortError(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`);
}

/** Collects one complete MCP list under a single bounded lifecycle. */
async function collectMcpPaginatedItems<T>(
  params: CollectMcpPaginatedItemsParams<T>,
): Promise<T[]> {
  const timeoutMs = clampPositiveTimerTimeoutMs(params.timeoutMs);
  if (timeoutMs === undefined) {
    throw new Error(`${params.label} requires a positive timeout`);
  }

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
  deadlineTimer.unref();
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
    for (let pageNumber = 0; pageNumber < MCP_CATALOG_MAX_PAGES; pageNumber += 1) {
      assertActive();
      const page = await racePromiseWithAbortSignal(
        params.loadPage({ cursor, requestTimeoutMs: timeoutMs, signal }),
        signal,
        () => abortError(signal, params.label),
      );
      assertActive();
      const measured = boundedJsonUtf8Bytes(
        page.serializedValue ?? { items: page.items, nextCursor: page.nextCursor },
        MCP_CATALOG_MAX_BYTES - collectedBytes,
      );
      if (!measured.complete || collectedBytes + measured.bytes > MCP_CATALOG_MAX_BYTES) {
        throw new Error(`${params.label} exceeded ${MCP_CATALOG_MAX_BYTES} bytes`);
      }
      collectedBytes += measured.bytes;

      for (const item of page.items) {
        if (items.length >= MCP_CATALOG_MAX_ITEMS) {
          throw new Error(`${params.label} exceeded ${MCP_CATALOG_MAX_ITEMS} ${params.itemLabel}`);
        }
        items.push(item);
      }

      const nextCursor = page.nextCursor;
      if (nextCursor === undefined) {
        return items;
      }
      if (seenCursors.has(nextCursor)) {
        throw new Error(`${params.label} returned a repeated pagination cursor`);
      }
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }
    throw new Error(`${params.label} exceeded ${MCP_CATALOG_MAX_PAGES} pages`);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

export async function listAllMcpTools(
  client: Client,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<Tool[]> {
  return await collectMcpPaginatedItems({
    label: "MCP tool listing",
    itemLabel: "tools",
    timeoutMs,
    signal,
    loadPage: async ({ cursor, requestTimeoutMs, signal: requestSignal }) => {
      const page = await client.request(
        { method: "tools/list", params: cursor === undefined ? undefined : { cursor } },
        {
          timeout: requestTimeoutMs,
          maxTotalTimeout: requestTimeoutMs,
          signal: requestSignal,
        },
      );
      return { items: page.tools, nextCursor: page.nextCursor, serializedValue: page };
    },
  });
}

export function listMcpServerItems(
  kind: "prompts" | "resources",
  {
    client,
    timeoutMs,
    signal,
    callerSignal,
    runRequest,
  }: {
    client: Client;
    timeoutMs: number;
    signal: AbortSignal;
    callerSignal?: AbortSignal;
    runRequest: <T>(
      request: (signal: AbortSignal) => Promise<T>,
      signal: AbortSignal,
    ) => Promise<T>;
  },
) {
  return collectMcpPaginatedItems<Prompt | Resource>({
    label: `MCP ${kind === "resources" ? "resource" : "prompt"} listing`,
    itemLabel: kind,
    timeoutMs,
    signal: callerSignal ? AbortSignal.any([signal, callerSignal]) : signal,
    loadPage: ({ cursor, requestTimeoutMs: timeout, signal: pageSignal }) =>
      runRequest(async (requestSignal) => {
        const requestParams = cursor === undefined ? undefined : { cursor };
        const requestOptions = { timeout, maxTotalTimeout: timeout, signal: requestSignal };
        if (kind === "resources") {
          const page = await client.request(
            { method: "resources/list", params: requestParams },
            requestOptions,
          );
          return { items: page.resources, nextCursor: page.nextCursor, serializedValue: page };
        }
        const page = await client.request(
          { method: "prompts/list", params: requestParams },
          requestOptions,
        );
        return { items: page.prompts, nextCursor: page.nextCursor, serializedValue: page };
      }, pageSignal),
  });
}

// Tool materialization awaits catalog listing. Bound it for servers without an
// explicit request timeout, with room for a cold remote (OAuth, HTTP) listing.
const BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS = 10_000;

export function getCatalogListTimeoutMs(rawServer: unknown, requestTimeoutMs: number): number {
  const record = asOptionalObjectRecord(rawServer);
  const configured = ["requestTimeoutMs", "timeout"].some(
    (key) => asPositiveFiniteNumber(record?.[key]) !== undefined,
  );
  return configured ? requestTimeoutMs : BUNDLE_MCP_CATALOG_LIST_TIMEOUT_MS;
}
