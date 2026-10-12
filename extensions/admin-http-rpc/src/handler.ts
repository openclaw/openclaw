import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  dispatchGatewayMethod,
  type GatewayMethodDispatchError,
} from "openclaw/plugin-sdk/gateway-method-runtime";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readJsonBodyWithLimit,
  sendHttpRequestRejection,
  WEBHOOK_BODY_READ_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-request-guards";
import { isAdminHttpRpcAllowedMethod, listAdminHttpRpcAllowedMethods } from "./methods.js";

type RpcResponse =
  | { id: string; ok: true; payload: unknown; meta?: Record<string, unknown> }
  | { id: string; ok: false; error: GatewayMethodDispatchError; meta?: Record<string, unknown> };

type ParsedRequest = {
  id: string;
  method: string;
  params?: unknown;
};

type ReadJsonBodyResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      status: number;
      message: string;
      closeAfterResponse?: boolean;
    };

function rpcHttpStatus(response: RpcResponse): number {
  if (response.ok) {
    return 200;
  }
  switch (response.error.code) {
    case "INVALID_REQUEST":
      return 400;
    case "APPROVAL_NOT_FOUND":
      return 404;
    case "UNAVAILABLE":
      return 503;
    case "AGENT_TIMEOUT":
      return 504;
    case "NOT_LINKED":
    case "NOT_PAIRED":
      return 409;
    default:
      return 500;
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function sendError(res: ServerResponse, status: number, error: { type: string; message: string }) {
  sendJson(res, status, { ok: false, error });
}

async function readAdminJsonBody(req: IncomingMessage): Promise<ReadJsonBodyResult> {
  const body = await readJsonBodyWithLimit(req, {
    // Admin responses are part of the client contract. The response-first profile
    // defers destruction so the transport owner can flush the JSON error.
    ...WEBHOOK_BODY_READ_DEFAULTS.postAuthResponseFirst,
    emptyObjectOnEmpty: false,
  });
  if (body.ok) {
    return body;
  }
  if (body.code === "INVALID_JSON") {
    return {
      ok: false,
      status: 400,
      message:
        body.error === "empty payload"
          ? "request body must be JSON"
          : "request body must be valid JSON",
    };
  }
  return {
    ok: false,
    status:
      body.code === "PAYLOAD_TOO_LARGE" ? 413 : body.code === "REQUEST_BODY_TIMEOUT" ? 408 : 400,
    message: body.error,
    closeAfterResponse: body.code !== "CONNECTION_CLOSED",
  };
}

function readRpcRequestBody(body: unknown):
  | { ok: true; request: ParsedRequest }
  | {
      ok: false;
      message: string;
    } {
  if (!isRecord(body)) {
    return { ok: false, message: "request body must be an object" };
  }
  const method = normalizeOptionalString(body.method);
  if (!method) {
    return { ok: false, message: "method must be a non-empty string" };
  }
  return {
    ok: true,
    request: {
      id: normalizeOptionalString(body.id) ?? randomUUID(),
      method,
      ...(Object.hasOwn(body, "params") ? { params: body.params } : {}),
    },
  };
}

async function dispatchAdminRpc(request: ParsedRequest): Promise<RpcResponse> {
  const unavailable: GatewayMethodDispatchError = {
    code: "UNAVAILABLE",
    message: "gateway method failed before returning a response",
  };
  try {
    const response = await dispatchGatewayMethod(request.method, request.params);
    return {
      id: request.id,
      ...(response.ok
        ? { ok: true as const, payload: response.payload }
        : { ok: false as const, error: response.error ?? unavailable }),
      ...(response.meta ? { meta: response.meta } : {}),
    };
  } catch {
    return {
      id: request.id,
      ok: false,
      error: unavailable,
    };
  }
}

/** Handle one gateway-authenticated Admin HTTP RPC request. */
export async function handleAdminHttpRpcRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if ((req.method ?? "GET").toUpperCase() !== "POST") {
    res.setHeader("Allow", "POST");
    sendError(res, 405, {
      type: "method_not_allowed",
      message: "Method Not Allowed",
    });
    return true;
  }

  const body = await readAdminJsonBody(req);
  if (!body.ok) {
    if (body.closeAfterResponse) {
      if (!res.headersSent) {
        res.setHeader("Cache-Control", "no-store");
      }
      await sendHttpRequestRejection(
        req,
        res,
        body.status,
        JSON.stringify({ ok: false, error: { type: "invalid_request", message: body.message } }),
        "application/json; charset=utf-8",
      );
    } else {
      sendError(res, body.status, {
        type: "invalid_request",
        message: body.message,
      });
    }
    return true;
  }

  const parsed = readRpcRequestBody(body.value);
  if (!parsed.ok) {
    sendError(res, 400, {
      type: "invalid_request",
      message: parsed.message,
    });
    return true;
  }

  if (!isAdminHttpRpcAllowedMethod(parsed.request.method)) {
    sendJson(res, 400, {
      id: parsed.request.id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `admin HTTP RPC method is not supported: ${parsed.request.method}`,
      },
    });
    return true;
  }

  if (parsed.request.method === "commands.list") {
    sendJson(res, 200, {
      id: parsed.request.id,
      ok: true,
      payload: { methods: listAdminHttpRpcAllowedMethods() },
    });
    return true;
  }

  await getPluginRuntimeGatewayRequestScope()?.revalidate?.();
  const response = await dispatchAdminRpc(parsed.request);
  sendJson(res, rpcHttpStatus(response), response);
  return true;
}
