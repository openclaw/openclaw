import { PlatformMessageNotDispatchedError } from "openclaw/plugin-sdk/error-runtime";
import { captureChannelReadAuthority } from "openclaw/plugin-sdk/fetch-runtime";
import { parseMediaContentLength } from "openclaw/plugin-sdk/media-runtime";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import { readResponseWithLimit } from "./read-response-with-limit.js";
import {
  buildTimeoutAbortSignal,
  closeDispatcher,
  createPinnedDispatcher,
  fetchWithRuntimeDispatcherOrMockedGlobal,
  resolvePinnedHostnameWithPolicy,
  type SsrFPolicy,
  type PinnedDispatcherPolicy,
} from "./transport-runtime-api.js";

// The SDK retries every fetch error except AbortError, including stale host authority.
class MatrixSdkAuthorityError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Matrix request authority expired", { cause });
    this.name = "AbortError";
  }
}

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

// Default ceiling for non-raw JSON control-plane responses (whoami, receipts,
// directory search, key-backup status, generic doRequest). Matrix homeservers
// are untrusted, so bound the body the same way the raw media path is bounded
// instead of buffering an unbounded stream via response.text().
const MATRIX_JSON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;

// matrix-js-sdk also uses the injected fetch for raw encrypted key bundles.
// Keep that path bounded without applying the tighter control-plane JSON cap.
const MATRIX_SDK_RESPONSE_MAX_BYTES = 64 * 1024 * 1024;

type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean | null | undefined>;

export type QueryParams = Record<string, QueryValue> | null | undefined;

type MatrixDispatcherRequestInit = RequestInit & {
  dispatcher?: ReturnType<typeof createPinnedDispatcher>;
};

function normalizeEndpoint(endpoint: string): string {
  if (!endpoint) {
    return "/";
  }
  return endpoint.startsWith("/") ? endpoint : `/${endpoint}`;
}

function applyQuery(url: URL, qs: QueryParams): void {
  if (!qs) {
    return;
  }
  for (const [key, rawValue] of Object.entries(qs)) {
    if (rawValue === undefined || rawValue === null) {
      continue;
    }
    if (Array.isArray(rawValue)) {
      for (const item of rawValue) {
        if (item === undefined || item === null) {
          continue;
        }
        url.searchParams.append(key, String(item));
      }
      continue;
    }
    url.searchParams.set(key, String(rawValue));
  }
}

function isRedirectStatus(statusCode: number): boolean {
  return statusCode >= 300 && statusCode < 400;
}

function toFetchUrl(resource: RequestInfo | URL): string {
  if (resource instanceof URL) {
    return resource.toString();
  }
  if (typeof resource === "string") {
    return resource;
  }
  return resource.url;
}

const MATRIX_STATE_AFTER_SYNC_PARAM = "org.matrix.msc4222.use_state_after";

function withoutMatrixStateAfterSyncParam(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return rawUrl;
  }

  if (!url.pathname.endsWith("/sync") || !url.searchParams.has(MATRIX_STATE_AFTER_SYNC_PARAM)) {
    return rawUrl;
  }

  url.searchParams.delete(MATRIX_STATE_AFTER_SYNC_PARAM);
  return url.toString();
}

function buildBufferedResponse(params: {
  source: Response;
  body: BodyInit;
  url: string;
}): Response {
  const response = new Response(params.body, {
    status: params.source.status,
    statusText: params.source.statusText,
    headers: new Headers(params.source.headers),
  });
  try {
    Object.defineProperty(response, "url", {
      value: params.source.url || params.url,
      configurable: true,
    });
  } catch {
    // Response.url is read-only in some runtimes; metadata is best-effort only.
  }
  return response;
}

async function enforceDeclaredResponseSize(params: {
  response: Response;
  maxBytes: number;
  createError: (length: number) => Error;
}): Promise<void> {
  const contentLength = params.response.headers.get("content-length");
  if (!contentLength) {
    return;
  }

  let length: number | null;
  try {
    length = parseMediaContentLength(contentLength);
  } catch (error) {
    await params.response.body?.cancel(error).catch(() => undefined);
    throw error;
  }
  if (length === null || length <= params.maxBytes) {
    return;
  }

  const error = params.createError(length);
  await params.response.body?.cancel(error).catch(() => undefined);
  throw error;
}

async function fetchWithMatrixDispatcher(params: {
  url: string;
  init: MatrixDispatcherRequestInit;
  assertCurrent?: () => void;
  onDispatch?: () => void;
}): Promise<Response> {
  // Keep this dispatcher-routing logic local to Matrix transport. Shared SSRF
  // fetches must stay fail-closed unless a retry path can preserve the
  // validated pinned-address binding. Route dispatcher-attached requests
  // through undici runtime fetch so the pinned dispatcher is preserved.
  params.assertCurrent?.();
  params.init.signal?.throwIfAborted();
  params.onDispatch?.();
  return await fetchWithRuntimeDispatcherOrMockedGlobal(params.url, params.init);
}

async function fetchWithMatrixGuardedRedirects(params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  assertCurrent?: () => void;
  beforeDispatch?: () => Promise<void> | undefined;
  assertSendCurrent?: () => void;
}): Promise<{ response: Response; release: () => Promise<void>; finalUrl: string }> {
  const assertDispatchCurrent = () => {
    params.assertCurrent?.();
    params.assertSendCurrent?.();
  };
  assertDispatchCurrent();
  let currentUrl = new URL(params.url);
  let method = (params.init?.method ?? "GET").toUpperCase();
  let body = params.init?.body;
  let headers = new Headers(params.init?.headers ?? {});
  const maxRedirects = 5;
  const visited = new Set<string>();
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    operation: "matrix.guarded-redirect-fetch",
    url: params.url,
  });

  let dispatched = false;
  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let dispatcher: ReturnType<typeof createPinnedDispatcher> | undefined;
    try {
      assertDispatchCurrent();
      signal?.throwIfAborted();
      const pinned = await resolvePinnedHostnameWithPolicy(currentUrl.hostname, {
        policy: params.ssrfPolicy,
        signal,
      });
      dispatcher = createPinnedDispatcher(pinned, params.dispatcherPolicy, params.ssrfPolicy);
      // The guard can persist dispatch custody, so reject stale requests before it runs.
      assertDispatchCurrent();
      signal?.throwIfAborted();
      await params.beforeDispatch?.();
      const response = await fetchWithMatrixDispatcher({
        url: currentUrl.toString(),
        assertCurrent: assertDispatchCurrent,
        onDispatch: () => {
          dispatched = true;
        },
        init: {
          ...params.init,
          method,
          body,
          headers,
          redirect: "manual",
          signal,
          dispatcher,
        } as MatrixDispatcherRequestInit,
      });

      if (!isRedirectStatus(response.status)) {
        return {
          response,
          release: async () => {
            cleanup();
            await closeDispatcher(dispatcher);
          },
          finalUrl: currentUrl.toString(),
        };
      }

      const location = response.headers.get("location");
      if (!location) {
        cleanup();
        await closeDispatcher(dispatcher);
        throw new Error(`Matrix redirect missing location header (${currentUrl.toString()})`);
      }

      const nextUrl = new URL(location, currentUrl);
      if (nextUrl.protocol !== currentUrl.protocol) {
        cleanup();
        await closeDispatcher(dispatcher);
        throw new Error(
          `Blocked cross-protocol redirect (${currentUrl.protocol} -> ${nextUrl.protocol})`,
        );
      }

      const nextUrlString = nextUrl.toString();
      if (visited.has(nextUrlString)) {
        cleanup();
        await closeDispatcher(dispatcher);
        throw new Error("Redirect loop detected");
      }
      visited.add(nextUrlString);

      if (nextUrl.origin !== currentUrl.origin) {
        headers = new Headers(headers);
        headers.delete("authorization");
      }

      if (
        response.status === 303 ||
        ((response.status === 301 || response.status === 302) &&
          method !== "GET" &&
          method !== "HEAD")
      ) {
        method = "GET";
        body = undefined;
        headers = new Headers(headers);
        headers.delete("content-type");
        headers.delete("content-length");
      }

      void response.body?.cancel().catch(() => undefined);
      await closeDispatcher(dispatcher);
      currentUrl = nextUrl;
    } catch (error) {
      cleanup();
      await closeDispatcher(dispatcher);
      if (!dispatched) {
        if (error instanceof PlatformMessageNotDispatchedError) {
          throw error;
        }
        // The durable callback must precede I/O, but it is not proof of I/O.
        // Roll back its queue marker if the final fence rejects the first fetch.
        const rejected = new PlatformMessageNotDispatchedError(
          error instanceof Error ? error.message : "Matrix request rejected before dispatch",
          { cause: error },
        );
        if (error instanceof MatrixSdkAuthorityError) {
          // Retain proven-unsent custody while stopping the SDK's network backoff.
          rejected.name = "AbortError";
        }
        throw rejected;
      }
      if (error instanceof PlatformMessageNotDispatchedError) {
        // A later redirect fence describes only that hop, not the earlier request.
        // Keep an unproven branch so the queue cannot misread it as a whole-send proof.
        throw new AggregateError(
          [error, new Error("An earlier Matrix request crossed the fetch boundary")],
          error.message,
          { cause: error },
        );
      }
      throw error;
    }
  }

  cleanup();
  throw new Error(`Too many redirects while requesting ${params.url}`);
}

export function createMatrixGuardedFetch(params: {
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  captureRequestAuthority?: () => (() => void) | undefined;
  captureSendCurrentness?: (
    resource: RequestInfo | URL,
    init?: RequestInit,
  ) => (() => void) | undefined;
  signal?: AbortSignal;
  captureRequestSignal?: () => AbortSignal | undefined;
  beforeRequest?: (resource: RequestInfo | URL, init?: RequestInit) => Promise<void> | undefined;
}): typeof fetch {
  return (async (resource: RequestInfo | URL, init?: RequestInit) => {
    const authority = params.captureRequestAuthority?.() ?? captureChannelReadAuthority();
    const assertCurrent = authority
      ? () => {
          try {
            authority();
          } catch (error) {
            throw new MatrixSdkAuthorityError(error);
          }
        }
      : undefined;
    const assertSendCurrent = params.captureSendCurrentness?.(resource, init);
    assertCurrent?.();
    const url = withoutMatrixStateAfterSyncParam(toFetchUrl(resource));
    const { signal, ...requestInit } = init ?? {};
    const signals = [params.signal, signal, params.captureRequestSignal?.()].filter(
      (candidate): candidate is AbortSignal => candidate != null,
    );
    const requestSignal = signals.length > 0 ? AbortSignal.any(signals) : undefined;
    const beforeRequest = params.beforeRequest;
    const { response, release } = await fetchWithMatrixGuardedRedirects({
      url,
      init: requestInit,
      signal: requestSignal,
      assertCurrent,
      assertSendCurrent,
      ssrfPolicy: params.ssrfPolicy,
      dispatcherPolicy: params.dispatcherPolicy,
      // Redirects belong to the same original timeline operation and task owner.
      beforeDispatch: beforeRequest ? () => beforeRequest(resource, init) : undefined,
    });

    try {
      await enforceDeclaredResponseSize({
        response,
        maxBytes: MATRIX_SDK_RESPONSE_MAX_BYTES,
        createError: (length) =>
          new Error(
            `Matrix SDK response exceeds size limit (${length} bytes > ${MATRIX_SDK_RESPONSE_MAX_BYTES} bytes)`,
          ),
      });
      const body = await readResponseWithLimit(response, MATRIX_SDK_RESPONSE_MAX_BYTES, {
        onOverflow: ({ maxBytes, size }) =>
          new Error(`Matrix SDK response exceeds size limit (${size} bytes > ${maxBytes} bytes)`),
      });
      assertCurrent?.();
      return buildBufferedResponse({
        source: response,
        body: Uint8Array.from(body),
        url,
      });
    } finally {
      try {
        await release();
      } finally {
        assertCurrent?.();
      }
    }
  }) as typeof fetch;
}

export async function performMatrixRequest(params: {
  homeserver: string;
  accessToken: string;
  method: HttpMethod;
  endpoint: string;
  qs?: QueryParams;
  body?: unknown;
  timeoutMs: number;
  raw?: boolean;
  maxBytes?: number;
  readIdleTimeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  allowAbsoluteEndpoint?: boolean;
  assertCurrent?: () => void;
  assertSendCurrent?: () => void;
  signal?: AbortSignal;
}): Promise<{ response: Response; text: string; buffer: Buffer }> {
  const assertCurrent = params.assertCurrent ?? captureChannelReadAuthority();
  assertCurrent?.();
  const isAbsoluteEndpoint =
    params.endpoint.startsWith("http://") || params.endpoint.startsWith("https://");
  if (isAbsoluteEndpoint && params.allowAbsoluteEndpoint !== true) {
    throw new Error(
      `Absolute Matrix endpoint is blocked by default: ${params.endpoint}. Set allowAbsoluteEndpoint=true to opt in.`,
    );
  }

  const baseUrl = isAbsoluteEndpoint
    ? new URL(params.endpoint)
    : new URL(`${params.homeserver.replace(/\/+$/u, "")}${normalizeEndpoint(params.endpoint)}`);
  applyQuery(baseUrl, params.qs);

  const headers = new Headers();
  headers.set("Accept", params.raw ? "*/*" : "application/json");
  if (params.accessToken) {
    headers.set("Authorization", `Bearer ${params.accessToken}`);
  }

  let body: BodyInit | undefined;
  if (params.body !== undefined) {
    if (
      params.body instanceof Uint8Array ||
      params.body instanceof ArrayBuffer ||
      typeof params.body === "string"
    ) {
      body = params.body as BodyInit;
    } else {
      headers.set("Content-Type", "application/json");
      body = JSON.stringify(params.body);
    }
  }

  const { response, release } = await fetchWithMatrixGuardedRedirects({
    url: baseUrl.toString(),
    init: {
      method: params.method,
      headers,
      body,
    },
    timeoutMs: params.timeoutMs,
    ssrfPolicy: params.ssrfPolicy,
    dispatcherPolicy: params.dispatcherPolicy,
    assertCurrent,
    assertSendCurrent: params.assertSendCurrent,
    signal: params.signal,
  });

  try {
    if (params.raw) {
      const rawMaxBytes = params.maxBytes ?? MATRIX_SDK_RESPONSE_MAX_BYTES;
      await enforceDeclaredResponseSize({
        response,
        maxBytes: rawMaxBytes,
        createError: (length) =>
          new MatrixMediaSizeLimitError(
            `Matrix media exceeds configured size limit (${length} bytes > ${rawMaxBytes} bytes)`,
          ),
      });
      const bytes = await readResponseWithLimit(response, rawMaxBytes, {
        onOverflow: ({ maxBytes, size }) =>
          new MatrixMediaSizeLimitError(
            `Matrix media exceeds configured size limit (${size} bytes > ${maxBytes} bytes)`,
          ),
        chunkTimeoutMs: params.readIdleTimeoutMs,
      });
      assertCurrent?.();
      return {
        response,
        text: bytes.toString("utf8"),
        buffer: bytes,
      };
    }
    const jsonMaxBytes = params.maxBytes ?? MATRIX_JSON_RESPONSE_MAX_BYTES;
    await enforceDeclaredResponseSize({
      response,
      maxBytes: jsonMaxBytes,
      createError: (length) =>
        new Error(
          `Matrix JSON response exceeds configured size limit (${length} bytes > ${jsonMaxBytes} bytes)`,
        ),
    });
    const buffer = await readResponseWithLimit(response, jsonMaxBytes, {
      onOverflow: ({ maxBytes, size }) =>
        new Error(
          `Matrix JSON response exceeds configured size limit (${size} bytes > ${maxBytes} bytes)`,
        ),
      chunkTimeoutMs: params.readIdleTimeoutMs,
      onIdleTimeout: ({ chunkTimeoutMs }) =>
        new Error(`Matrix JSON response stalled: no data received for ${chunkTimeoutMs}ms`),
    });
    assertCurrent?.();
    return {
      response,
      text: buffer.toString("utf8"),
      buffer,
    };
  } finally {
    try {
      await release();
    } finally {
      assertCurrent?.();
    }
  }
}
