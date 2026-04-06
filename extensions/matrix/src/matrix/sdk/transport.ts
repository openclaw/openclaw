import type { PinnedDispatcherPolicy } from "openclaw/plugin-sdk/infra-runtime";
import {
  buildTimeoutAbortSignal,
  closeDispatcher,
  createPinnedDispatcher,
  resolvePinnedHostnameWithPolicy,
  type SsrFPolicy,
} from "../../runtime-api.js";
import { MatrixMediaSizeLimitError } from "../media-errors.js";
import { readResponseWithLimit } from "./read-response-with-limit.js";

export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

type QueryValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | Array<string | number | boolean | null | undefined>;

export type QueryParams = Record<string, QueryValue> | null | undefined;

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

function buildBufferedResponse(params: {
  source: Response;
  body: ArrayBuffer;
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

type ErrorWithCause = {
  code?: unknown;
  message?: unknown;
  cause?: unknown;
};

function* iterateErrorCauseChain(error: unknown): Generator<ErrorWithCause> {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    yield current as ErrorWithCause;
    current = (current as ErrorWithCause).cause;
  }
}

function canBypassPinnedDispatcherForCompatibility(policy?: PinnedDispatcherPolicy): boolean {
  return !policy || policy.mode === "direct";
}

function isPinnedDispatcherRuntimeCompatibilityError(error: unknown): boolean {
  for (const candidate of iterateErrorCauseChain(error)) {
    const message = typeof candidate.message === "string" ? candidate.message : "";
    if (
      candidate.code === "UND_ERR_INVALID_ARG" &&
      message.toLowerCase().includes("onrequeststart")
    ) {
      return true;
    }
  }
  return false;
}

async function fetchWithPinnedDispatcherCompatibilityRetry(params: {
  url: string;
  init: RequestInit & { dispatcher?: unknown };
  dispatcherPolicy?: PinnedDispatcherPolicy;
  dispatcher: ReturnType<typeof createPinnedDispatcher> | undefined;
}): Promise<Response> {
  // Keep this compatibility fallback local to Matrix transport. Shared SSRF
  // fetches must stay fail-closed unless a retry path can preserve the
  // validated pinned-address binding.
  try {
    return await fetch(params.url, params.init);
  } catch (error) {
    if (
      !params.dispatcher ||
      !canBypassPinnedDispatcherForCompatibility(params.dispatcherPolicy) ||
      !isPinnedDispatcherRuntimeCompatibilityError(error)
    ) {
      throw error;
    }
    await closeDispatcher(params.dispatcher);
    const { dispatcher: _dispatcher, ...retryInit } = params.init;
    return await fetch(params.url, retryInit);
  }
}

async function fetchWithMatrixGuardedRedirects(params: {
  url: string;
  init?: RequestInit;
  signal?: AbortSignal;
  timeoutMs?: number;
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}): Promise<{ response: Response; release: () => Promise<void>; finalUrl: string }> {
  let currentUrl = new URL(params.url);
  let method = (params.init?.method ?? "GET").toUpperCase();
  let body = params.init?.body;
  let headers = new Headers(params.init?.headers ?? {});
  const maxRedirects = 5;
  const visited = new Set<string>();
  const { signal, cleanup } = buildTimeoutAbortSignal({
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    let dispatcher: ReturnType<typeof createPinnedDispatcher> | undefined;
    try {
      const pinned = await resolvePinnedHostnameWithPolicy(currentUrl.hostname, {
        policy: params.ssrfPolicy,
      });
      dispatcher = createPinnedDispatcher(pinned, params.dispatcherPolicy, params.ssrfPolicy);
      const response = await fetchWithPinnedDispatcherCompatibilityRetry({
        url: currentUrl.toString(),
        dispatcherPolicy: params.dispatcherPolicy,
        dispatcher,
        init: {
          ...params.init,
          method,
          body,
          headers,
          redirect: "manual",
          signal,
          dispatcher,
        } as RequestInit & { dispatcher: unknown },
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

      void response.body?.cancel();
      await closeDispatcher(dispatcher);
      currentUrl = nextUrl;
    } catch (error) {
      cleanup();
      await closeDispatcher(dispatcher);
      throw error;
    }
  }

  cleanup();
  throw new Error(`Too many redirects while requesting ${params.url}`);
}

export function createMatrixGuardedFetch(params: {
  ssrfPolicy?: SsrFPolicy;
  dispatcherPolicy?: PinnedDispatcherPolicy;
}): typeof fetch {
  return (async (resource: RequestInfo | URL, init?: RequestInit) => {
    const url = toFetchUrl(resource);
    const { signal, ...requestInit } = init ?? {};
    const { response, release } = await fetchWithMatrixGuardedRedirects({
      url,
      init: requestInit,
      signal: signal ?? undefined,
      ssrfPolicy: params.ssrfPolicy,
      dispatcherPolicy: params.dispatcherPolicy,
    });

    try {
      const body = await response.arrayBuffer();
      return buildBufferedResponse({
        source: response,
        body,
        url,
      });
    } finally {
      await release();
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
}): Promise<{ response: Response; text: string; buffer: Buffer }> {
  const isAbsoluteEndpoint =
    params.endpoint.startsWith("http://") || params.endpoint.startsWith("https://");
  if (isAbsoluteEndpoint && params.allowAbsoluteEndpoint !== true) {
    throw new Error(
      `Absolute Matrix endpoint is blocked by default: ${params.endpoint}. Set allowAbsoluteEndpoint=true to opt in.`,
    );
  }

  const baseUrl = isAbsoluteEndpoint
    ? new URL(params.endpoint)
    : new URL(normalizeEndpoint(params.endpoint), params.homeserver);
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
  });

  try {
    if (params.raw) {
      const contentLength = response.headers.get("content-length");
      if (params.maxBytes && contentLength) {
        const length = Number(contentLength);
        if (Number.isFinite(length) && length > params.maxBytes) {
          throw new MatrixMediaSizeLimitError(
            `Matrix media exceeds configured size limit (${length} bytes > ${params.maxBytes} bytes)`,
          );
        }
      }
      const bytes = params.maxBytes
        ? await readResponseWithLimit(response, params.maxBytes, {
            onOverflow: ({ maxBytes, size }) =>
              new MatrixMediaSizeLimitError(
                `Matrix media exceeds configured size limit (${size} bytes > ${maxBytes} bytes)`,
              ),
            chunkTimeoutMs: params.readIdleTimeoutMs,
          })
        : Buffer.from(await response.arrayBuffer());
      return {
        response,
        text: bytes.toString("utf8"),
        buffer: bytes,
      };
    }
    const text = await response.text();
    return {
      response,
      text,
      buffer: Buffer.from(text, "utf8"),
    };
  } finally {
    await release();
  }
}
