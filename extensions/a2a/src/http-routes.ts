import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { PluginRuntime } from "openclaw/plugin-sdk/runtime-store";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { boundedJsonUtf8Bytes } from "openclaw/plugin-sdk/text-utility-runtime";
import {
  isRequestBodyLimitError,
  readRequestBodyWithLimit,
} from "openclaw/plugin-sdk/webhook-ingress";
import { sendHttpRequestRejection } from "openclaw/plugin-sdk/webhook-request-guards";
import {
  A2A_JSON_RPC_ERROR_CODES,
  A2aProtocolError,
  contentTypeNotSupported,
  invalidParams,
  methodNotFound,
} from "./a2a-errors.js";
import { A2A_EXTENSIONS_HEADER, type A2aStreamResponse } from "./a2a-model.js";
import {
  A2A_AGENT_CARD_PATHS,
  A2A_EXTENDED_CARD_PATH,
  A2A_JSONRPC_PATH,
  A2A_REST_PATH,
  buildA2aAgentCard,
  type A2aResolvedCapabilities,
} from "./agent-card.js";
import { toRpcErrorObject, writeJsonResponse, type A2aRpcErrorObject } from "./http-json.js";
import { executeA2aMethod, streamA2aMethod, type A2aMethodContext } from "./methods.js";
import {
  A2aRpcRequestSchema,
  assertRequiredExtensions,
  assertSupportedVersion,
  activatedExtensions,
  isA2aStreamingMethod,
  resolveA2aRpcMethod,
} from "./protocol.js";
import type { A2aPushConfigStore } from "./push-config-store.js";
import { handleA2aRestRequest, resolvePeerName } from "./rest.js";
import {
  isResponseWritable,
  onResponseClosed,
  writeSseError,
  writeSseHead,
  writeSseResult,
} from "./sse.js";
import type { A2aTaskStore } from "./task-store.js";
import type { A2aChannelConfig, ResolvedA2aChannelAccount } from "./types.js";

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BODY_BYTES = 1024 * 1024;
// This cap stays enforced when an operator disables the per-peer rate limit.
const MAX_BATCH_REQUESTS = 30;
const DEFAULT_REPLY_TIMEOUT_MS = 120_000;
const DEFAULT_STREAM_TIMEOUT_MS = 120_000;
const DEFAULT_RATE_LIMIT_PER_MINUTE = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

type A2aRpcIdentifier = string | number | null;

type A2aRpcResponse =
  | { jsonrpc: "2.0"; id: A2aRpcIdentifier; result: unknown }
  | { jsonrpc: "2.0"; id: A2aRpcIdentifier; error: A2aRpcErrorObject };

function createRpcError(id: A2aRpcIdentifier, code: number, message: string): A2aRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function writeRpcResponse(
  response: ServerResponse,
  value: A2aRpcResponse | A2aRpcResponse[],
): void {
  const measured = boundedJsonUtf8Bytes(value, MAX_RESPONSE_BODY_BYTES);
  if (measured.complete) {
    writeJsonResponse(response, 200, value);
    return;
  }
  const errorMessage = "A2A response exceeds the 1 MiB limit";
  const bounded = Array.isArray(value)
    ? value.map((entry) => createRpcError(entry.id, -32000, errorMessage))
    : createRpcError(value.id, -32000, errorMessage);
  // Request IDs can consume nearly the entire inbound budget. Drop correlation
  // only when an already-oversized response's replacement still cannot fit.
  const fallback = boundedJsonUtf8Bytes(bounded, MAX_RESPONSE_BODY_BYTES).complete
    ? bounded
    : Array.isArray(bounded)
      ? bounded.map(() => createRpcError(null, -32000, errorMessage))
      : createRpcError(null, -32000, errorMessage);
  writeJsonResponse(response, 200, fallback);
}

/** Reject a request whose content type is present and clearly not JSON. */
function assertJsonContentType(request: IncomingMessage): void {
  const contentType = request.headers["content-type"];
  if (contentType === undefined) {
    return;
  }
  const essence = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (essence === "application/json" || essence.endsWith("+json")) {
    return;
  }
  throw contentTypeNotSupported(
    `Unsupported content type "${essence}"; A2A JSON-RPC requires application/json`,
  );
}

/** Everything the HTTP routes need from the owning account's gateway session. */
export type A2aHttpRoutesDeps = {
  account: ResolvedA2aChannelAccount;
  config: OpenClawConfig;
  a2aConfig: A2aChannelConfig;
  channelRuntime: PluginRuntime["channel"];
  store: A2aTaskStore;
  pushConfigs: A2aPushConfigStore;
  capabilities: A2aResolvedCapabilities;
  version: string;
  /** Card content derives from the config loaded at account start (§8.6.1). */
  cardModifiedAt: Date;
};

/**
 * Build the HTTP request handler shared by every A2A route: agent cards, the
 * JSON-RPC endpoint (unary, batch, and SSE streaming), and the REST binding.
 */
export function createA2aHttpHandler(deps: A2aHttpRoutesDeps) {
  const { account, config, a2aConfig, store, pushConfigs, capabilities, version } = deps;

  function createAgentCard(request: IncomingMessage, extended: boolean) {
    return buildA2aAgentCard({
      config,
      a2aConfig,
      version,
      request,
      capabilities,
      extended,
    });
  }

  /**
   * Serve a card with the caching validators of §8.6.1.
   *
   * The ETag is hashed from the rendered body rather than the config,
   * because the advertised origin derives from the request `Host`: two
   * peers can legitimately receive different bytes for the same config.
   * Conditional requests are answered with 304 so a peer that already
   * holds the card pays nothing but the header round-trip.
   */
  function writeCardResponse(
    request: IncomingMessage,
    response: ServerResponse,
    card: unknown,
    visibility: "public" | "private",
  ): void {
    const body = JSON.stringify(card);
    const etag = `"${createHash("sha256").update(body).digest("base64url")}"`;
    // The extended card is authenticated content; a shared cache must
    // never store it, which is what `private` (vs `public`) forbids.
    const cacheControl = visibility === "public" ? "public, max-age=300" : "private, max-age=300";
    response.setHeader("Cache-Control", cacheControl);
    response.setHeader("ETag", etag);
    const conditional = request.headers["if-none-match"] ?? "";
    const matches =
      conditional.includes("*") ||
      conditional
        .split(",")
        .map((entry) => entry.trim())
        .includes(etag);
    if (matches) {
      response.statusCode = 304;
      response.end();
      return;
    }
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Last-Modified", deps.cardModifiedAt.toUTCString());
    response.statusCode = 200;
    response.end(body);
  }

  function createMethodContext(params: {
    request: IncomingMessage;
    peerName: string;
  }): A2aMethodContext {
    return {
      account,
      config,
      a2aConfig,
      channelRuntime: deps.channelRuntime,
      store,
      pushConfigs,
      capabilities,
      peerName: params.peerName,
      version,
      request: params.request,
      replyTimeoutMs: DEFAULT_REPLY_TIMEOUT_MS,
      streamTimeoutMs: DEFAULT_STREAM_TIMEOUT_MS,
      registerInlinePushConfig: (taskId, pushConfig) => {
        if (!capabilities.pushNotifications) {
          return;
        }
        pushConfigs.create(params.peerName, {
          taskId,
          url: pushConfig.url,
          ...(pushConfig.id ? { id: pushConfig.id } : {}),
          ...(pushConfig.tenant ? { tenant: pushConfig.tenant } : {}),
          ...(pushConfig.token ? { token: pushConfig.token } : {}),
          ...(pushConfig.authentication ? { authentication: pushConfig.authentication } : {}),
        });
      },
    };
  }

  const peerRequestTimes = new Map<string, number[]>();

  function isRateLimited(peerName: string): boolean {
    const maximum = a2aConfig.rateLimitPerMinute ?? DEFAULT_RATE_LIMIT_PER_MINUTE;
    if (maximum === 0) {
      return false;
    }
    const now = Date.now();
    const requests = (peerRequestTimes.get(peerName) ?? []).filter(
      (timestamp) => now - timestamp < RATE_LIMIT_WINDOW_MS,
    );
    if (requests.length >= maximum) {
      peerRequestTimes.set(peerName, requests);
      return true;
    }
    requests.push(now);
    peerRequestTimes.set(peerName, requests);
    return false;
  }

  /** Run one unary JSON-RPC request; returns undefined for notifications. */
  async function processRpcRequest(
    input: unknown,
    peerName: string,
    request: IncomingMessage,
  ): Promise<A2aRpcResponse | undefined> {
    const parsed = A2aRpcRequestSchema.safeParse(input);
    const candidateId = isRecord(input) ? input.id : undefined;
    const id =
      typeof candidateId === "string" || typeof candidateId === "number" ? candidateId : null;
    const notification = parsed.success && !Object.hasOwn(parsed.data, "id");

    if (isRateLimited(peerName)) {
      return notification ? undefined : createRpcError(id, -32000, "Peer is rate limited");
    }

    if (!parsed.success) {
      return createRpcError(
        id,
        A2A_JSON_RPC_ERROR_CODES.INVALID_REQUEST,
        "Invalid JSON-RPC request",
      );
    }

    const rpcRequest = parsed.data;
    const methodContext = createMethodContext({ request, peerName });

    try {
      assertSupportedVersion(request);
      assertRequiredExtensions(request, a2aConfig);

      const resolved = resolveA2aRpcMethod(rpcRequest.method);
      if (!resolved) {
        throw methodNotFound(rpcRequest.method);
      }
      // A stream cannot be interleaved into a batch response, so a
      // streaming method inside a batch reports as a normal error entry.
      if (resolved.streaming) {
        throw invalidParams(
          `${rpcRequest.method} is a streaming method and cannot be used in a batch request`,
        );
      }
      const result = await executeA2aMethod(methodContext, resolved, rpcRequest.params);
      return notification ? undefined : { jsonrpc: "2.0", id, result };
    } catch (error) {
      if (notification) {
        return undefined;
      }
      return { jsonrpc: "2.0", id, error: toRpcErrorObject(error) };
    }
  }

  /**
   * Serve one streaming JSON-RPC request as SSE.
   *
   * The first event is fetched before the headers are flushed so a
   * rejected request still comes back as an ordinary JSON-RPC error
   * instead of a 200 stream carrying only an error frame.
   */
  async function processStreamingRpcRequest(
    input: unknown,
    peerName: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const parsed = A2aRpcRequestSchema.safeParse(input);
    const candidateId = isRecord(input) ? input.id : undefined;
    const id =
      typeof candidateId === "string" || typeof candidateId === "number" ? candidateId : null;

    const fail = (error: unknown) => {
      writeJsonResponse(response, 200, {
        jsonrpc: "2.0",
        id,
        error: toRpcErrorObject(error),
      });
    };

    if (isRateLimited(peerName)) {
      // Streaming must not sidestep the per-peer limiter that governs unary
      // requests; the refusal is emitted before the SSE stream opens.
      fail(new A2aProtocolError(-32000, "Peer is rate limited"));
      return;
    }

    if (!parsed.success) {
      fail(
        new A2aProtocolError(A2A_JSON_RPC_ERROR_CODES.INVALID_REQUEST, "Invalid JSON-RPC request"),
      );
      return;
    }
    const methodContext = createMethodContext({ request, peerName });
    const resolved = resolveA2aRpcMethod(parsed.data.method);

    let iterator: AsyncIterator<A2aStreamResponse> | undefined;
    let first: IteratorResult<A2aStreamResponse> | undefined;
    try {
      assertSupportedVersion(request);
      // Checked before the stream opens: once headers are flushed the
      // only way to report a refusal is an SSE error frame.
      assertRequiredExtensions(request, a2aConfig);
      if (!resolved?.streaming) {
        throw methodNotFound(parsed.data.method);
      }
      const generator = streamA2aMethod(methodContext, resolved, parsed.data.params);
      iterator = generator[Symbol.asyncIterator]();
      first = await iterator.next();
    } catch (error) {
      await iterator?.return?.(undefined);
      fail(error);
      return;
    }

    if (first.done || !first.value) {
      await iterator.return?.(undefined);
      writeJsonResponse(response, 200, { jsonrpc: "2.0", id, result: null });
      return;
    }

    const activated = activatedExtensions(request, a2aConfig);
    writeSseHead(
      response,
      activated.length > 0 ? { [A2A_EXTENSIONS_HEADER]: activated.join(",") } : undefined,
    );
    writeSseResult(response, { jsonrpc: "2.0", id, result: first.value });

    let closed = false;
    const stopListening = onResponseClosed(request, response, () => {
      closed = true;
    });
    try {
      while (true) {
        if (closed || !isResponseWritable(response)) {
          break;
        }
        const next = await iterator.next();
        if (next.done) {
          break;
        }
        writeSseResult(response, { jsonrpc: "2.0", id, result: next.value });
      }
    } catch (error) {
      if (isResponseWritable(response)) {
        writeSseError(response, { jsonrpc: "2.0", id, error: toRpcErrorObject(error) });
      }
    } finally {
      stopListening();
      await iterator.return?.(undefined).catch(() => undefined);
      if (isResponseWritable(response)) {
        response.end();
      }
    }
  }

  const handler = async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    // httpx and several other standard clients normalize `base_url` to a
    // trailing slash, so `/a2a/v1/` must mean `/a2a/v1`. Our route
    // grammar has no path segment that is meaningful only with a slash,
    // so one trailing slash is stripped everywhere except root.
    const rawPathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const pathname =
      rawPathname.length > 1 && rawPathname.endsWith("/") ? rawPathname.slice(0, -1) : rawPathname;

    if (
      request.method === "GET" &&
      // SAFETY: widening the literal-path tuple only exposes the base `includes` contract.
      (A2A_AGENT_CARD_PATHS as readonly string[]).includes(pathname)
    ) {
      try {
        assertSupportedVersion(request);
      } catch {
        writeJsonResponse(response, 400, { error: "Unsupported A2A version" });
        return true;
      }
      writeCardResponse(request, response, createAgentCard(request, false), "public");
      return true;
    }

    // The authenticated extended card is served at its own path because it
    // publishes operator-authored text and must never be world-readable.
    if (
      (request.method === "GET" || request.method === "POST") &&
      (pathname === A2A_EXTENDED_CARD_PATH || pathname === `${A2A_REST_PATH}/extendedAgentCard`)
    ) {
      const peerName = resolvePeerName(request, a2aConfig);
      if (!peerName) {
        writeJsonResponse(response, 401, {
          error: "Unauthorized; the extended agent card requires a configured Bearer token",
        });
        return true;
      }
      try {
        assertSupportedVersion(request);
        const methodContext = createMethodContext({ request, peerName });
        const card = await executeA2aMethod(methodContext, { method: "GetExtendedAgentCard" }, {});
        writeCardResponse(request, response, card, "private");
      } catch (error) {
        writeJsonResponse(response, 200, {
          error: toRpcErrorObject(error),
        });
      }
      return true;
    }

    if (a2aConfig.rest?.enabled === true && pathname.startsWith(`${A2A_REST_PATH}/`)) {
      return await handleA2aRestRequest(
        { a2aConfig, createMethodContext, isRateLimited },
        request,
        response,
        pathname,
      );
    }

    if (request.method !== "POST" || pathname !== A2A_JSONRPC_PATH) {
      writeJsonResponse(response, 404, { error: "Not found" });
      return true;
    }

    const peerName = resolvePeerName(request, a2aConfig);
    if (!peerName) {
      writeJsonResponse(response, 401, {
        error: "Unauthorized; configure channels.a2a.peers with a matching Bearer token",
      });
      return true;
    }

    let body: string;
    try {
      assertJsonContentType(request);
      body = await readRequestBodyWithLimit(request, {
        maxBytes: MAX_REQUEST_BODY_BYTES,
        // Defer destruction so the rejection below reaches the peer before the close.
        destroyOnLimit: false,
      });
    } catch (error) {
      const bodyRejection = isRequestBodyLimitError(error, "PAYLOAD_TOO_LARGE")
        ? { statusCode: 413, body: { error: "Request body exceeds the 1 MiB limit" } }
        : isRequestBodyLimitError(error, "REQUEST_BODY_TIMEOUT")
          ? {
              statusCode: 200,
              body: createRpcError(null, -32000, "Request body could not be read"),
            }
          : undefined;
      if (bodyRejection) {
        response.setHeader("cache-control", "no-store");
        await sendHttpRequestRejection(
          request,
          response,
          bodyRejection.statusCode,
          JSON.stringify(bodyRejection.body),
          "application/json; charset=utf-8",
        );
        return true;
      }
      // Even pre-parse rejections keep the JSON-RPC envelope (§5): a peer
      // must never receive a bare error object from this endpoint.
      writeJsonResponse(response, 200, {
        jsonrpc: "2.0",
        id: null,
        error: toRpcErrorObject(error),
      });
      return true;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(body);
    } catch {
      writeJsonResponse(
        response,
        200,
        createRpcError(null, A2A_JSON_RPC_ERROR_CODES.PARSE_ERROR, "Parse error"),
      );
      return true;
    }

    if (Array.isArray(payload)) {
      if (payload.length === 0) {
        writeJsonResponse(
          response,
          200,
          createRpcError(
            null,
            A2A_JSON_RPC_ERROR_CODES.INVALID_REQUEST,
            "Invalid JSON-RPC request",
          ),
        );
        return true;
      }
      if (payload.length > MAX_BATCH_REQUESTS) {
        const error = isRateLimited(peerName)
          ? createRpcError(null, -32000, "Peer is rate limited")
          : createRpcError(
              null,
              -32000,
              `A2A batch exceeds the ${MAX_BATCH_REQUESTS} request limit`,
            );
        writeRpcResponse(response, error);
        return true;
      }
      const responses = (
        await Promise.all(payload.map((entry) => processRpcRequest(entry, peerName, request)))
      ).filter((entry): entry is A2aRpcResponse => entry !== undefined);
      const result = responses.length > 0 ? responses : undefined;
      if (result) {
        writeRpcResponse(response, result);
      } else {
        response.statusCode = 200;
        response.end();
      }
      return true;
    }

    if (
      isRecord(payload) &&
      typeof payload.method === "string" &&
      isA2aStreamingMethod(payload.method)
    ) {
      await processStreamingRpcRequest(payload, peerName, request, response);
      return true;
    }

    const result = await processRpcRequest(payload, peerName, request);
    if (result) {
      writeRpcResponse(response, result);
    } else {
      response.statusCode = 200;
      response.end();
    }
    return true;
  };

  return handler;
}
