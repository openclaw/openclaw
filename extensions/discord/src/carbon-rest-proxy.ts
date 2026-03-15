import {
  DiscordError,
  RateLimitError,
  RequestClient,
  type QueuedRequest,
  type RequestData,
} from "@buape/carbon";
import { wrapFetchWithAbortSignal } from "../../../src/infra/fetch.js";
import { makeProxyFetch } from "../../../src/infra/net/proxy-fetch.js";

const carbonProxyFetchMarker = Symbol.for("openclaw.discord.carbon.proxyFetch");

type CarbonRequestClientRuntime = {
  abortController: AbortController | null;
  executeRequest: (request: QueuedRequest) => Promise<unknown>;
  options: {
    baseUrl: string;
    tokenHeader?: "Bot" | "Bearer";
    timeout?: number;
  };
  scheduleRateLimit: (routeKey: string, path: string, error: RateLimitError) => void;
  updateBucketFromHeaders: (routeKey: string, path: string, response: Response) => void;
  waitForBucket: (routeKey: string) => Promise<void>;
};

type CarbonRequestClientProxyMarker = {
  [carbonProxyFetchMarker]?: typeof fetch;
};

function getCarbonRequestClientRuntime(rest: RequestClient): CarbonRequestClientRuntime {
  return rest as unknown as CarbonRequestClientRuntime;
}

function getCarbonRequestClientToken(rest: RequestClient): string {
  return (rest as unknown as { token: string }).token;
}

function resolveRequestUrl(
  baseUrl: string,
  path: string,
  query?: Record<string, string | number | boolean>,
): string {
  const queryString = query
    ? `?${Object.entries(query)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join("&")}`
    : "";
  return `${baseUrl}${path}${queryString}`;
}

function buildHeaders(token: string, data?: RequestData, tokenHeader: "Bot" | "Bearer" = "Bot") {
  const headers =
    token === "webhook"
      ? new Headers()
      : new Headers({
          Authorization: `${tokenHeader} ${token}`,
        });
  if (data?.headers) {
    for (const [key, value] of Object.entries(data.headers)) {
      headers.set(key, value);
    }
  }
  return headers;
}

function hasFilePayload(body: unknown): boolean {
  const files = resolveFilePayload(body);
  return typeof body === "object" && body !== null && files.length > 0;
}

function resolveFilePayload(
  body: unknown,
): Array<{ data: BlobPart | Blob; name: string; contentType?: string; description?: string }> {
  if (typeof body !== "object" || body === null) {
    return [];
  }
  if ("files" in body && Array.isArray(body.files)) {
    return body.files as Array<{ data: BlobPart | Blob; name: string; description?: string }>;
  }
  if (
    "data" in body &&
    typeof body.data === "object" &&
    body.data !== null &&
    "files" in body.data &&
    Array.isArray(body.data.files)
  ) {
    return body.data.files as Array<{ data: BlobPart | Blob; name: string; description?: string }>;
  }
  return [];
}

type MultipartAttachment = { id: number; filename: string; description?: string };

function resolveMultipartPayloadBody(body: unknown): {
  payload: Record<string, unknown>;
  attachments: MultipartAttachment[];
} {
  if (typeof body === "string") {
    const attachments: MultipartAttachment[] = [];
    return {
      payload: { content: body, attachments },
      attachments,
    };
  }
  if (typeof body !== "object" || body === null) {
    const attachments: MultipartAttachment[] = [];
    return {
      payload: { attachments },
      attachments,
    };
  }
  if ("files" in body && Array.isArray(body.files)) {
    const attachments: MultipartAttachment[] = [];
    return {
      payload: {
        ...(body as Record<string, unknown>),
        files: undefined,
        attachments,
      },
      attachments,
    };
  }
  if (
    "data" in body &&
    typeof body.data === "object" &&
    body.data !== null &&
    "files" in body.data &&
    Array.isArray(body.data.files)
  ) {
    const attachments: MultipartAttachment[] = [];
    return {
      payload: {
        ...(body as Record<string, unknown>),
        data: {
          ...(body.data as Record<string, unknown>),
          files: undefined,
          attachments,
        },
      },
      attachments,
    };
  }
  const attachments: MultipartAttachment[] = [];
  return {
    payload: {
      ...(body as Record<string, unknown>),
      attachments,
    },
    attachments,
  };
}

function buildBody(headers: Headers, data?: RequestData): BodyInit | undefined {
  if (data?.body == null) {
    return undefined;
  }
  if (hasFilePayload(data.body)) {
    const { payload, attachments } = resolveMultipartPayloadBody(data.body);
    const formData = new FormData();
    const files = resolveFilePayload(data.body);
    for (const [index, file] of files.entries()) {
      // Preserve MIME type: prefer explicit contentType, fall back to existing Blob type.
      const blob =
        file.data instanceof Blob && !file.contentType
          ? file.data
          : new Blob(
              [file.data as BlobPart],
              file.contentType ? { type: file.contentType } : undefined,
            );
      formData.append(`files[${index}]`, blob, file.name);
      attachments.push({
        id: index,
        filename: file.name,
        description: file.description,
      });
    }
    formData.append("payload_json", JSON.stringify(payload));
    return formData;
  }
  headers.set("Content-Type", "application/json");
  return data.rawBody ? (data.body as BodyInit) : JSON.stringify(data.body);
}

async function parseResponseBody(
  response: Response,
): Promise<{ rawBody: string; parsedBody: unknown }> {
  let rawBody = "";
  try {
    rawBody = await response.text();
  } catch {
    rawBody = "";
  }
  if (!rawBody) {
    return { rawBody, parsedBody: undefined };
  }
  try {
    return { rawBody, parsedBody: JSON.parse(rawBody) };
  } catch {
    return { rawBody, parsedBody: undefined };
  }
}

function resolveRateLimitBody(response: Response, rawBody: string, parsedBody: unknown) {
  if (
    parsedBody &&
    typeof parsedBody === "object" &&
    "retry_after" in parsedBody &&
    "message" in parsedBody
  ) {
    return parsedBody as { message: string; retry_after: number; global: boolean };
  }
  const retryAfterHeader = response.headers.get("Retry-After");
  return {
    message: typeof parsedBody === "string" ? parsedBody : rawBody || "You are being rate limited.",
    retry_after:
      retryAfterHeader && !Number.isNaN(Number(retryAfterHeader)) ? Number(retryAfterHeader) : 1,
    global: response.headers.get("X-RateLimit-Scope") === "global",
  };
}

function resolveDiscordErrorBody(rawBody: string, parsedBody: unknown) {
  if (parsedBody && typeof parsedBody === "object") {
    return parsedBody as { message: string; code?: number };
  }
  return {
    message: rawBody || "Discord API error",
    code: 0,
  };
}

export function attachFetchToCarbonRequestClient(
  rest: RequestClient,
  fetchImpl: typeof fetch,
): RequestClient {
  const client = getCarbonRequestClientRuntime(rest);
  const markedRest = rest as unknown as CarbonRequestClientProxyMarker;
  if (markedRest[carbonProxyFetchMarker] === fetchImpl) {
    return rest;
  }

  client.executeRequest = async function executeRequestWithFetch(request: QueuedRequest) {
    const { method, path, data, query, routeKey } = request;
    await client.waitForBucket(routeKey);
    const url = resolveRequestUrl(client.options.baseUrl, path, query);
    const headers = buildHeaders(
      getCarbonRequestClientToken(rest),
      data,
      client.options.tokenHeader,
    );

    const abortController = new AbortController();
    client.abortController = abortController;
    const body = buildBody(headers, data);
    const timeoutMs =
      typeof client.options.timeout === "number" && client.options.timeout > 0
        ? client.options.timeout
        : undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => abortController.abort(), timeoutMs);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: abortController.signal,
      });
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    const { rawBody, parsedBody } = await parseResponseBody(response);
    if (response.status === 429) {
      const rateLimitError = new RateLimitError(
        response,
        resolveRateLimitBody(response, rawBody, parsedBody),
      );
      client.scheduleRateLimit(routeKey, path, rateLimitError);
      throw rateLimitError;
    }

    client.updateBucketFromHeaders(routeKey, path, response);
    if (response.status >= 400 && response.status < 600) {
      throw new DiscordError(response, resolveDiscordErrorBody(rawBody, parsedBody));
    }
    if (parsedBody !== undefined) {
      return parsedBody;
    }
    if (rawBody.length > 0) {
      return rawBody;
    }
    return null;
  };

  markedRest[carbonProxyFetchMarker] = fetchImpl;
  return rest;
}

export function attachProxyToCarbonRequestClient(
  rest: RequestClient,
  proxyUrl: string | undefined,
): RequestClient {
  const proxy = proxyUrl?.trim();
  if (!proxy) {
    return rest;
  }
  try {
    const parsed = new URL(proxy);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return rest;
    }
  } catch {
    return rest;
  }
  return attachFetchToCarbonRequestClient(rest, wrapFetchWithAbortSignal(makeProxyFetch(proxy)));
}
