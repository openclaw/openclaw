import { DiscordError, RateLimitError, RequestClient, type RequestData } from "@buape/carbon";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { danger } from "../../../../src/globals.js";
import { wrapFetchWithAbortSignal } from "../../../../src/infra/fetch.js";
import type { RuntimeEnv } from "../../../../src/runtime.js";

const discordRequestClientFetchPatched = Symbol.for("openclaw.discord.request-client.fetch");

type RequestClientMutable = {
  abortController: AbortController | null;
  executeRequest?: (request: QueuedRequestLike) => Promise<unknown>;
  options: {
    tokenHeader?: "Bot" | "Bearer";
    baseUrl?: string;
    timeout?: number;
  };
  scheduleRateLimit: (routeKey: string, path: string, error: RateLimitError) => void;
  updateBucketFromHeaders: (routeKey: string, path: string, response: Response) => void;
  waitForBucket: (routeKey: string) => Promise<void>;
  token: string;
  [discordRequestClientFetchPatched]?: boolean;
};

type QueuedRequestLike = {
  method: string;
  path: string;
  data?: RequestData;
  query?: Record<string, string | number | boolean>;
  routeKey: string;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveDiscordRequestBody(data?: RequestData): {
  headers: Headers;
  body: BodyInit | undefined;
} {
  const headers = new Headers();
  if (data?.headers) {
    for (const [key, value] of Object.entries(data.headers)) {
      headers.set(key, value);
    }
  }

  if (data?.body == null) {
    return { headers, body: undefined };
  }

  const payload = data.body;
  if (
    isPlainObject(payload) &&
    ("files" in payload || (isPlainObject(payload.data) && "files" in payload.data))
  ) {
    const formData = new FormData();
    const normalizedPayload = { ...payload } as Record<string, unknown>;
    const attachmentTarget = isPlainObject(normalizedPayload.data)
      ? normalizedPayload.data
      : normalizedPayload;
    if (!Array.isArray(attachmentTarget.attachments)) {
      attachmentTarget.attachments = [];
    }
    const files = Array.isArray(normalizedPayload.files)
      ? normalizedPayload.files
      : isPlainObject(normalizedPayload.data) && Array.isArray(normalizedPayload.data.files)
        ? normalizedPayload.data.files
        : [];
    for (const [index, file] of files.entries()) {
      if (!isPlainObject(file) || typeof file.name !== "string") {
        continue;
      }
      const rawFileData = file.data;
      const blob = rawFileData instanceof Blob ? rawFileData : new Blob([rawFileData as BlobPart]);
      formData.append(`files[${index}]`, blob, file.name);
      (attachmentTarget.attachments as Array<Record<string, unknown>>).push({
        id: index,
        filename: file.name,
        description: typeof file.description === "string" ? file.description : undefined,
      });
    }
    const serializedPayload = isPlainObject(normalizedPayload)
      ? { ...normalizedPayload, files: undefined }
      : normalizedPayload;
    formData.append("payload_json", JSON.stringify(serializedPayload));
    return { headers, body: formData };
  }

  if (!data.rawBody) {
    headers.set("Content-Type", "application/json");
    return { headers, body: JSON.stringify(payload) };
  }
  return { headers, body: payload as BodyInit };
}

function resolveDiscordErrorBody(rawBody: unknown): { message: string; code: number } {
  if (isPlainObject(rawBody)) {
    return {
      message:
        typeof rawBody.message === "string" && rawBody.message.trim().length > 0
          ? rawBody.message
          : "Discord API error",
      code: typeof rawBody.code === "number" ? rawBody.code : 0,
    };
  }
  if (typeof rawBody === "string" && rawBody.trim().length > 0) {
    return { message: rawBody, code: 0 };
  }
  return { message: "Discord API error", code: 0 };
}

export function patchDiscordRequestClientFetch(
  rest: RequestClient,
  fetcher: typeof fetch,
): RequestClient {
  const internal = rest as unknown as RequestClientMutable;
  if (internal[discordRequestClientFetchPatched]) {
    return rest;
  }
  const fetchImpl = wrapFetchWithAbortSignal(fetcher);

  internal.executeRequest = async (request: QueuedRequestLike) => {
    const { method, path, data, query, routeKey } = request;
    await internal.waitForBucket(routeKey);
    const queryString = query
      ? `?${Object.entries(query)
          .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
          .join("&")}`
      : "";
    const url = `${internal.options.baseUrl ?? "https://discord.com/api"}${path}${queryString}`;
    const { headers, body } = resolveDiscordRequestBody(data);
    if (internal.token !== "webhook") {
      headers.set("Authorization", `${internal.options.tokenHeader ?? "Bot"} ${internal.token}`);
    }

    internal.abortController = new AbortController();
    const timeoutMs =
      typeof internal.options.timeout === "number" && internal.options.timeout > 0
        ? internal.options.timeout
        : undefined;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    if (timeoutMs !== undefined) {
      timeoutId = setTimeout(() => {
        internal.abortController?.abort();
      }, timeoutMs);
    }

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        body,
        signal: internal.abortController.signal,
      });
    } finally {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
    }

    let rawText = "";
    let parsedBody: unknown;
    try {
      rawText = await response.text();
    } catch {
      rawText = "";
    }
    if (rawText.length > 0) {
      try {
        parsedBody = JSON.parse(rawText);
      } catch {
        parsedBody = undefined;
      }
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("Retry-After");
      const retryAfter =
        isPlainObject(parsedBody) && typeof parsedBody.retry_after === "number"
          ? parsedBody.retry_after
          : retryAfterHeader && !Number.isNaN(Number(retryAfterHeader))
            ? Number(retryAfterHeader)
            : 1;
      const rateLimitError = new RateLimitError(response, {
        message:
          isPlainObject(parsedBody) && typeof parsedBody.message === "string"
            ? parsedBody.message
            : rawText || "You are being rate limited.",
        retry_after: retryAfter,
        global: response.headers.get("X-RateLimit-Scope") === "global",
      });
      internal.scheduleRateLimit(routeKey, path, rateLimitError);
      throw rateLimitError;
    }

    internal.updateBucketFromHeaders(routeKey, path, response);
    if (response.status >= 400 && response.status < 600) {
      throw new DiscordError(response, resolveDiscordErrorBody(parsedBody ?? rawText));
    }

    if (parsedBody !== undefined) {
      return parsedBody;
    }
    if (rawText.length > 0) {
      return rawText;
    }
    return null;
  };

  Object.defineProperty(internal, discordRequestClientFetchPatched, {
    value: true,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return rest;
}

export function resolveDiscordRestFetch(
  proxyUrl: string | undefined,
  runtime: RuntimeEnv,
): typeof fetch {
  const proxy = proxyUrl?.trim();
  if (!proxy) {
    return fetch;
  }
  try {
    const agent = new ProxyAgent(proxy);
    const fetcher = ((input: RequestInfo | URL, init?: RequestInit) =>
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher: agent,
      }) as unknown as Promise<Response>) as typeof fetch;
    runtime.log?.("discord: rest proxy enabled");
    return wrapFetchWithAbortSignal(fetcher);
  } catch (err) {
    runtime.error?.(danger(`discord: invalid rest proxy: ${String(err)}`));
    return fetch;
  }
}
