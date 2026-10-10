import { inspect } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  captureChannelReadAuthority,
  captureEffectAuthority,
} from "openclaw/plugin-sdk/fetch-runtime";
import { clampTimerTimeoutMs, resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { getDiscordEndpointRuntime, type DiscordEndpointRuntime } from "../endpoint-runtime.js";
import { captureDiscordRequestAuthority } from "./request-authority.js";
import { serializeRequestBody, type RequestData } from "./rest-body.js";
import {
  DiscordError,
  RateLimitError,
  readDiscordCode,
  readDiscordMessage,
  readRetryAfter,
} from "./rest-errors.js";
import { appendQuery, createRouteKey } from "./rest-routes.js";
import { RestScheduler, type RequestPriority, type RequestQuery } from "./rest-scheduler.js";
import { isDiscordRateLimitBody } from "./schemas.js";

export { DiscordError, isUnknownDiscordVoiceStateError, RateLimitError } from "./rest-errors.js";

export type RequestClientOptions = {
  baseUrl?: string;
  /** Complete versioned REST base supplied by the Discord endpoint override. */
  apiBaseUrl?: string;
  signal?: AbortSignal;
  timeout?: number;
  queueRequests?: boolean;
  fetch?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
};

type NormalizedRequestClientOptions = RequestClientOptions & {
  apiBaseUrl: string;
  timeout: number;
};

type RequestDispatchData = {
  data?: RequestData;
  assertCurrent?: () => void;
  effect: ReturnType<typeof captureEffectAuthority>;
};

const defaultOptions = {
  baseUrl: "https://discord.com/api",
  timeout: 15_000,
  queueRequests: true,
};

// Cap the REST response body well above any legitimate Discord JSON payload
// (bulk message/member fetches stay in the low hundreds of KB) so a controlled
// or hijacked endpoint cannot flood the body into an unbounded buffer (OOM).
const DISCORD_REST_RESPONSE_BODY_MAX_BYTES = 8 * 1024 * 1024;
const GZIP_MAGIC = [0x1f, 0x8b] as const;

function createResponseBodyOverflowError(size: number | "decompressed output"): Error {
  return new Error(
    `Discord REST response body exceeds ${DISCORD_REST_RESPONSE_BODY_MAX_BYTES} bytes (received ${size})`,
  );
}

async function readResponseBodyText(response: Response, idleTimeoutMs: number): Promise<string> {
  const buffer = await readResponseWithLimit(response, DISCORD_REST_RESPONSE_BODY_MAX_BYTES, {
    chunkTimeoutMs: idleTimeoutMs,
    onOverflow: ({ size }) => createResponseBodyOverflowError(size),
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`Discord REST response stalled: no data received for ${chunkTimeoutMs}ms`),
  });
  if (!buffer.byteLength) {
    return "";
  }
  if (buffer[0] === GZIP_MAGIC[0] && buffer[1] === GZIP_MAGIC[1]) {
    try {
      return gunzipSync(buffer, {
        maxOutputLength: DISCORD_REST_RESPONSE_BODY_MAX_BYTES,
      }).toString("utf8");
    } catch (err: unknown) {
      if (err instanceof RangeError && "code" in err && err.code === "ERR_BUFFER_TOO_LARGE") {
        throw createResponseBodyOverflowError("decompressed output");
      }
      throw err;
    }
  }
  return buffer.toString("utf8");
}

function coerceResponseBody(raw: string): unknown {
  if (!raw) {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export class RequestClient {
  readonly options: NormalizedRequestClientOptions;
  protected token: string;
  protected customFetch: DiscordEndpointRuntime["fetch"] | undefined;
  private readonly guardedEndpoint: boolean;
  protected requestControllers = new Set<AbortController>();
  private scheduler: RestScheduler<RequestDispatchData>;

  constructor(token: string, options?: RequestClientOptions) {
    const endpoint = getDiscordEndpointRuntime();
    const resolvedOptions = endpoint
      ? {
          ...options,
          apiBaseUrl: endpoint.descriptor.restApiBaseUrl,
          fetch: endpoint.fetch,
        }
      : options;
    this.token = token.replace(/^Bot\s+/i, "");
    this.customFetch = resolvedOptions?.fetch;
    this.guardedEndpoint = endpoint !== undefined;
    this.options = normalizeRequestClientOptions(resolvedOptions);
    this.scheduler = new RestScheduler<RequestDispatchData>(
      async (request) =>
        await this.executeRequest(
          request.method,
          request.path,
          { data: request.data?.data, query: request.query },
          request.routeKey,
          request.data?.assertCurrent,
          request.data?.effect,
        ),
    );
  }

  async get(path: string, query?: RequestQuery): Promise<unknown> {
    return await this.request("GET", path, { query });
  }

  async post(path: string, data?: RequestData, query?: RequestQuery): Promise<unknown> {
    return await this.request("POST", path, { data, query });
  }

  async patch(path: string, data?: RequestData, query?: RequestQuery): Promise<unknown> {
    return await this.request("PATCH", path, { data, query });
  }

  async put(path: string, data?: RequestData, query?: RequestQuery): Promise<unknown> {
    return await this.request("PUT", path, { data, query });
  }

  async delete(path: string, data?: RequestData, query?: RequestQuery): Promise<unknown> {
    return await this.request("DELETE", path, { data, query });
  }

  protected async request(
    method: string,
    path: string,
    params: { data?: RequestData; query?: RequestQuery },
  ): Promise<unknown> {
    const routeKey = createRouteKey(method, path);
    // A shared scheduler can drain under another caller's async context. Capture
    // both host action and read authority before queueing or rate-limit retries.
    const assertActionAuthority = captureDiscordRequestAuthority();
    const assertReadAuthority = captureChannelReadAuthority();
    const effect = captureEffectAuthority();
    const assertCurrent = assertActionAuthority
      ? () => {
          assertActionAuthority();
          assertReadAuthority?.();
        }
      : assertReadAuthority;
    assertCurrent?.();
    if (!this.options.queueRequests) {
      return await this.executeRequest(method, path, params, routeKey, assertCurrent, effect);
    }
    return await this.scheduler.enqueue({
      method,
      path,
      priority: getRequestPriority(method, path),
      query: params.query,
      data: { data: params.data, assertCurrent, effect },
    });
  }

  protected async executeRequest(
    method: string,
    path: string,
    params: { data?: RequestData; query?: RequestQuery },
    routeKey = createRouteKey(method, path),
    assertCurrent?: () => void,
    effect = captureEffectAuthority(),
  ): Promise<unknown> {
    const url = `${this.options.apiBaseUrl}${appendQuery(path, params.query)}`;
    const headers = new Headers({
      "User-Agent": "OpenClaw Discord",
    });
    if (this.token !== "webhook") {
      headers.set("Authorization", `Bot ${this.token}`);
    }
    const body = serializeRequestBody(params.data, headers);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeout);
    timeout.unref?.();
    const signal = this.options.signal
      ? AbortSignal.any([this.options.signal, controller.signal])
      : controller.signal;
    this.requestControllers.add(controller);
    try {
      assertCurrent?.();
      const init = { method, headers, body, signal };
      const request = () => {
        assertCurrent?.();
        return this.customFetch && assertCurrent
          ? this.customFetch(url, init, assertCurrent)
          : (this.customFetch ?? fetch)(url, init);
      };
      const response = this.guardedEndpoint
        ? await effect.run(request)
        : await effect.initiate(request);
      const text = await readResponseBodyText(response, this.options.timeout).catch(
        (error: unknown) => {
          if (response.ok) {
            throw error;
          }
          return "";
        },
      );
      const parsed = coerceResponseBody(text);
      this.scheduler.recordResponse(routeKey, path, response, parsed);
      if (response.status === 204) {
        return undefined;
      }
      if (response.status === 429) {
        const rateLimitBody = isDiscordRateLimitBody(parsed) ? parsed : undefined;
        throw new RateLimitError(response, {
          message: readDiscordMessage(rateLimitBody, "Rate limited"),
          retry_after: readRetryAfter(rateLimitBody, response, 1),
          code: readDiscordCode(rateLimitBody),
          global: Boolean(rateLimitBody?.global),
        });
      }
      if (!response.ok) {
        throw new DiscordError(response, parsed);
      }
      return parsed;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Discord request failed: ${inspect(error)}`, { cause: error });
    } finally {
      clearTimeout(timeout);
      this.requestControllers.delete(controller);
    }
  }

  clearQueue(): void {
    this.scheduler.clearQueue();
  }

  get queueSize(): number {
    return this.scheduler.queueSize;
  }

  abortAllRequests(): void {
    this.scheduler.abortPending();
    for (const controller of this.requestControllers) {
      controller.abort();
    }
    this.requestControllers.clear();
  }
}

function normalizeRequestClientOptions(
  options?: RequestClientOptions,
): NormalizedRequestClientOptions {
  const merged = { ...defaultOptions, ...options };
  return {
    ...merged,
    apiBaseUrl: options?.apiBaseUrl ?? `${options?.baseUrl ?? defaultOptions.baseUrl}/v10`,
    timeout:
      clampTimerTimeoutMs(merged.timeout, 1) ?? resolveTimerTimeoutMs(defaultOptions.timeout, 1),
  };
}

function getRequestPriority(method: string, path: string): RequestPriority {
  const normalizedMethod = method.toUpperCase();
  const normalizedPath = path.toLowerCase();
  if (/^\/interactions\/\d+\/[^/]+\/callback$/.test(normalizedPath)) {
    return "critical";
  }
  return normalizedMethod === "GET" ? "background" : "standard";
}
