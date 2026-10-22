import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readRequestBodyWithLimit } from "openclaw/plugin-sdk/webhook-ingress";
import { A2A_JSON_RPC_ERROR_CODES, invalidParams, methodNotFound } from "./a2a-errors.js";
import { A2A_REST_PATH } from "./agent-card.js";
import { toRpcErrorObject, writeJsonResponse } from "./http-json.js";
import { executeA2aMethod, streamA2aMethod, type A2aMethodContext } from "./methods.js";
import {
  assertRequiredExtensions,
  assertSupportedVersion,
  resolveA2aRpcMethod,
} from "./protocol.js";
import { isResponseWritable, onResponseClosed, writeSseHead, writeSseResult } from "./sse.js";
import type { A2aChannelConfig } from "./types.js";

/**
 * Resolve the authenticated peer name from the request's Bearer token.
 *
 * Tokens are compared by SHA-256 digest with `timingSafeEqual` so an
 * attacker cannot learn a configured token through response timing.
 */
export function resolvePeerName(
  request: IncomingMessage,
  config: A2aChannelConfig,
): string | undefined {
  const authorization = request.headers.authorization;
  const token = authorization?.match(/^Bearer\s+([^\s]+)$/i)?.[1];
  if (!token) {
    return undefined;
  }
  const presentedDigest = createHash("sha256").update(token).digest();
  for (const [peerName, peer] of Object.entries(config.peers ?? {})) {
    const configuredDigest = createHash("sha256").update(peer.token).digest();
    if (timingSafeEqual(presentedDigest, configuredDigest)) {
      return peerName;
    }
  }
  return undefined;
}

/**
 * Map an A2A JSON-RPC error code to the HTTP status used by the REST binding.
 *
 * The v1.0.0 specification table (§5.4) assigns several A2A errors their own
 * HTTP status instead of a blanket 400: a cancelable-state violation is 409
 * (the task state conflicts with the request), an unsupported media type is
 * 415, and an invalid agent response is 502 (the failure originated behind
 * the gateway, in the agent).
 */
function restStatusForCode(code: number): number {
  switch (code) {
    case A2A_JSON_RPC_ERROR_CODES.TASK_NOT_FOUND:
    case A2A_JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND:
      return 404;
    case A2A_JSON_RPC_ERROR_CODES.TASK_NOT_CANCELABLE:
      return 409;
    case A2A_JSON_RPC_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED:
      return 415;
    case A2A_JSON_RPC_ERROR_CODES.INVALID_AGENT_RESPONSE:
      return 502;
    case A2A_JSON_RPC_ERROR_CODES.INTERNAL_ERROR:
      return 500;
    default:
      return 400;
  }
}

/**
 * Canonical `google.rpc.Code` name for the REST binding.
 *
 * §5.4 assigns a gRPC status per A2A error type, and the §11.6 example carries it
 * in `error.status`. The name is not derivable from the HTTP status alone: 400
 * covers both FAILED_PRECONDITION and UNIMPLEMENTED, and peers branch on the
 * name rather than re-deriving it.
 */
function restStatusNameForCode(code: number): string {
  switch (code) {
    case A2A_JSON_RPC_ERROR_CODES.TASK_NOT_FOUND:
    case A2A_JSON_RPC_ERROR_CODES.METHOD_NOT_FOUND:
      return "NOT_FOUND";
    case A2A_JSON_RPC_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED:
    case A2A_JSON_RPC_ERROR_CODES.INVALID_PARAMS:
    case A2A_JSON_RPC_ERROR_CODES.INVALID_REQUEST:
    case A2A_JSON_RPC_ERROR_CODES.PARSE_ERROR:
      return "INVALID_ARGUMENT";
    case A2A_JSON_RPC_ERROR_CODES.INVALID_AGENT_RESPONSE:
    case A2A_JSON_RPC_ERROR_CODES.INTERNAL_ERROR:
      return "INTERNAL";
    case A2A_JSON_RPC_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED:
    case A2A_JSON_RPC_ERROR_CODES.UNSUPPORTED_OPERATION:
    case A2A_JSON_RPC_ERROR_CODES.VERSION_NOT_SUPPORTED:
      return "UNIMPLEMENTED";
    default:
      return "FAILED_PRECONDITION";
  }
}

const MAX_REQUEST_BODY_BYTES = 1024 * 1024;

/** Inputs the REST binding borrows from the owning HTTP handler. */
export type A2aRestHandlerDeps = {
  a2aConfig: A2aChannelConfig;
  /** Builds the per-request method context (peer, request, stores). */
  createMethodContext: (params: { request: IncomingMessage; peerName: string }) => A2aMethodContext;
  /**
   * Shares the JSON-RPC endpoint's per-peer limiter, so the REST binding
   * cannot be used to sidestep it (spec treats both as one protocol surface).
   */
  isRateLimited: (peerName: string) => boolean;
};

/**
 * HTTP+JSON/REST binding (spec §11).
 *
 * Paths mirror the normative `google.api.http` annotations. Errors use
 * the ProtoJSON form of `google.rpc.Status` so peers can read the
 * `ErrorInfo` reason instead of guessing from the status code.
 */
export async function handleA2aRestRequest(
  deps: A2aRestHandlerDeps,
  request: IncomingMessage,
  response: ServerResponse,
  pathname: string,
): Promise<boolean> {
  const peerName = resolvePeerName(request, deps.a2aConfig);
  if (!peerName) {
    writeJsonResponse(response, 401, { error: "Unauthorized" });
    return true;
  }
  if (deps.isRateLimited(peerName)) {
    // §5.4 maps RESOURCE_EXHAUSTED to HTTP 429; the ProtoJSON body carries
    // the gRPC status name like every other REST error here.
    writeJsonResponse(response, 429, {
      error: {
        code: 429,
        status: "RESOURCE_EXHAUSTED",
        message: "Peer is rate limited",
        details: [],
      },
    });
    return true;
  }
  const method = request.method ?? "GET";
  const suffix = pathname.slice(A2A_REST_PATH.length) || "/";
  const query = new URL(request.url ?? "/", "http://localhost").searchParams;
  const methodContext = deps.createMethodContext({ request, peerName });

  const sendResult = (value: unknown, status = 200) => {
    writeJsonResponse(response, status, value);
  };
  const sendError = (error: unknown) => {
    const rpcError = toRpcErrorObject(error);
    const status = restStatusForCode(rpcError.code);
    sendResult(
      {
        error: {
          code: status,
          status: restStatusNameForCode(rpcError.code),
          message: rpcError.message,
          // Only A2A-specific errors carry an ErrorInfo reason
          // (§11.6). A plain 404 for an unmatched route is not an A2A
          // error type, so its details stay empty.
          details: rpcError.data ?? [],
        },
      },
      status,
    );
  };

  try {
    assertSupportedVersion(request);
    assertRequiredExtensions(request, deps.a2aConfig);
    const result = await runRestRoute({
      method,
      suffix,
      query,
      request,
      response,
      methodContext,
    });
    if (result === undefined) {
      // Streams own the response; nothing further to write.
      return true;
    }
    if (result === null) {
      response.statusCode = 204;
      response.end();
      return true;
    }
    sendResult(result);
    return true;
  } catch (error) {
    sendError(error);
    return true;
  }
}

/** Resolve one REST route to an A2A method; streams return undefined. */
async function runRestRoute(params: {
  method: string;
  suffix: string;
  query: URLSearchParams;
  request: IncomingMessage;
  response: ServerResponse;
  methodContext: A2aMethodContext;
}): Promise<unknown> {
  const { method, suffix, query, request, response, methodContext } = params;
  const readBody = async (): Promise<unknown> => {
    const raw = await readRequestBodyWithLimit(request, {
      maxBytes: MAX_REQUEST_BODY_BYTES,
      destroyOnLimit: false,
    });
    if (!raw.trim()) {
      return {};
    }
    try {
      return JSON.parse(raw);
    } catch {
      // A malformed body is a request problem, not a transport one: report it
      // as INVALID_ARGUMENT instead of a bare SyntaxError (which would render
      // as an opaque 500).
      throw invalidParams("Request body is not valid JSON");
    }
  };
  // No `id` parameter: the REST binding emits bare `StreamResponse`
  // frames with no JSON-RPC envelope to correlate (§11.5).
  const stream = async (
    resolved: NonNullable<ReturnType<typeof resolveA2aRpcMethod>>,
    requestParams: unknown,
  ) => {
    const iterator = streamA2aMethod(methodContext, resolved, requestParams)[
      Symbol.asyncIterator
    ]();
    const first = await iterator.next();
    if (first.done || !first.value) {
      await iterator.return?.(undefined);
      return;
    }
    writeSseHead(response);
    // The REST binding streams bare `StreamResponse` objects, with no
    // JSON-RPC envelope around them.
    writeSseResult(response, first.value);
    let closed = false;
    const stop = onResponseClosed(request, response, () => {
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
        writeSseResult(response, next.value);
      }
    } finally {
      stop();
      await iterator.return?.(undefined).catch(() => undefined);
      if (isResponseWritable(response)) {
        response.end();
      }
    }
  };

  if (suffix === "/message:send" && method === "POST") {
    return await executeA2aMethod(methodContext, { method: "SendMessage" }, await readBody());
  }
  if (suffix === "/message:stream" && method === "POST") {
    await stream(
      { method: "SendStreamingMessage", capability: "streaming", streaming: true },
      await readBody(),
    );
    return undefined;
  }
  if (suffix === "/tasks" && method === "GET") {
    return await executeA2aMethod(
      methodContext,
      { method: "ListTasks" },
      {
        ...(query.get("contextId") ? { contextId: query.get("contextId") } : {}),
        ...(query.get("status") ? { status: query.get("status") } : {}),
        ...(query.get("statusTimestampAfter")
          ? { statusTimestampAfter: query.get("statusTimestampAfter") }
          : {}),
        ...(query.get("pageSize") ? { pageSize: Number(query.get("pageSize")) } : {}),
        ...(query.get("pageToken") ? { pageToken: query.get("pageToken") } : {}),
        ...(query.get("historyLength")
          ? { historyLength: Number(query.get("historyLength")) }
          : {}),
        ...(query.get("includeArtifacts")
          ? { includeArtifacts: query.get("includeArtifacts") === "true" }
          : {}),
      },
    );
  }

  const taskMatch = /^\/tasks\/([^/]+?)(?::(cancel|subscribe))?$/u.exec(suffix);
  if (taskMatch) {
    const taskId = decodeURIComponent(taskMatch[1] ?? "");
    const action = taskMatch[2];
    if (action === "cancel" && method === "POST") {
      // The path-bound id wins over any id in the body, matching the
      // gRPC transcoding rule that path fields are removed from it.
      return await executeA2aMethod(
        methodContext,
        { method: "CancelTask" },
        // SAFETY: the REST body was already JSON-parsed, so it is an object or array.
        { ...((await readBody()) as object), id: taskId },
      );
    }
    if (action === "subscribe" && (method === "GET" || method === "POST")) {
      await stream(
        { method: "SubscribeToTask", capability: "streaming", streaming: true },
        {
          id: taskId,
        },
      );
      return undefined;
    }
    if (!action && method === "GET") {
      return await executeA2aMethod(
        methodContext,
        { method: "GetTask" },
        {
          id: taskId,
          ...(query.get("historyLength")
            ? { historyLength: Number(query.get("historyLength")) }
            : {}),
        },
      );
    }
  }

  const pushMatch = /^\/tasks\/([^/]+)\/pushNotificationConfigs(?:\/([^/]+))?$/u.exec(suffix);
  if (pushMatch) {
    const taskId = decodeURIComponent(pushMatch[1] ?? "");
    const configId = pushMatch[2] ? decodeURIComponent(pushMatch[2]) : undefined;
    if (!configId && method === "POST") {
      // §CreateTaskPushNotificationConfig maps `taskId` to the path
      // (`post: "/tasks/{task_id=*}/pushNotificationConfigs"`, body:
      // "*"), so a compliant body carries only {id, url, ...}. The
      // path wins over any taskId a peer also puts in the body, the
      // same precedence gRPC transcoding gives path-bound fields.
      // SAFETY: the REST body was already JSON-parsed by readBody; schemas validate it next.
      const body = (await readBody()) as Record<string, unknown>;
      return await executeA2aMethod(
        methodContext,
        { method: "CreateTaskPushNotificationConfig", capability: "pushNotifications" },
        { ...body, taskId },
      );
    }
    if (!configId && method === "GET") {
      return await executeA2aMethod(
        methodContext,
        { method: "ListTaskPushNotificationConfigs", capability: "pushNotifications" },
        {
          taskId,
          ...(query.get("pageSize") ? { pageSize: Number(query.get("pageSize")) } : {}),
          ...(query.get("pageToken") ? { pageToken: query.get("pageToken") } : {}),
        },
      );
    }
    if (configId && method === "GET") {
      return await executeA2aMethod(
        methodContext,
        { method: "GetTaskPushNotificationConfig", capability: "pushNotifications" },
        { taskId, id: configId },
      );
    }
    if (configId && method === "DELETE") {
      await executeA2aMethod(
        methodContext,
        { method: "DeleteTaskPushNotificationConfig", capability: "pushNotifications" },
        { taskId, id: configId },
      );
      return null;
    }
  }

  throw methodNotFound(`${method} ${A2A_REST_PATH}${suffix}`);
}
