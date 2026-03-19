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

async function fetchWithSafeRedirects(url: URL, init: RequestInit): Promise<Response> {
  let currentUrl = new URL(url.toString());
  let method = (init.method ?? "GET").toUpperCase();
  let body = init.body;
  let headers = new Headers(init.headers ?? {});
  const maxRedirects = 5;

  for (let redirectCount = 0; redirectCount <= maxRedirects; redirectCount += 1) {
    const response = await fetch(currentUrl, {
      ...init,
      method,
      body,
      headers,
      redirect: "manual",
    });

    if (!isRedirectStatus(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Matrix redirect missing location header (${currentUrl.toString()})`);
    }

    const nextUrl = new URL(location, currentUrl);
    if (nextUrl.protocol !== currentUrl.protocol) {
      throw new Error(
        `Blocked cross-protocol redirect (${currentUrl.protocol} -> ${nextUrl.protocol})`,
      );
    }

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

    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects while requesting ${url.toString()}`);
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

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await fetchWithSafeRedirects(baseUrl, {
      method: params.method,
      headers,
      body,
      signal: controller.signal,
    });
    if (params.raw) {
      const contentLength = response.headers.get("content-length");
      if (params.maxBytes && contentLength) {
        const length = Number(contentLength);
        if (Number.isFinite(length) && length > params.maxBytes) {
          throw new Error(
            `Matrix media exceeds configured size limit (${length} bytes > ${params.maxBytes} bytes)`,
          );
        }
      }
      const bytes = params.maxBytes
        ? await readResponseWithLimit(response, params.maxBytes, {
            onOverflow: ({ maxBytes, size }) =>
              new Error(
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
    clearTimeout(timeoutId);
  }
}
