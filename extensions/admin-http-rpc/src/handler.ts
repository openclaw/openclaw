import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  dispatchGatewayMethod,
  type GatewayMethodDispatchError,
} from "openclaw/plugin-sdk/gateway-method-runtime";
import { sendJsonNoStore as sendJson } from "openclaw/plugin-sdk/http-response-runtime";
import { getPluginRuntimeGatewayRequestScope } from "openclaw/plugin-sdk/plugin-runtime";
import { isRecord, normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  readJsonBodyWithLimit,
  sendHttpRequestRejection,
  WEBHOOK_BODY_READ_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-request-guards";

/** Only these methods can cross the trusted operator HTTP surface. */
const ADMIN_HTTP_RPC_ALLOWED_METHOD_GROUPS = {
  gateway: [
    "health",
    "status",
    "logs.tail",
    "usage.status",
    "usage.cost",
    "gateway.restart.request",
    "gateway.suspend.prepare",
    "gateway.suspend.status",
    "gateway.suspend.resume",
  ],
  discovery: ["commands.list"],
  config: [
    "config.get",
    "config.schema",
    "config.schema.lookup",
    "config.set",
    "config.patch",
    "config.apply",
  ],
  channels: ["channels.status", "channels.start", "channels.stop", "channels.logout"],
  web: ["web.login.start", "web.login.wait"],
  models: ["models.list", "models.authStatus"],
  agents: ["agents.list", "agents.create", "agents.update", "agents.delete"],
  approvals: [
    "exec.approvals.get",
    "exec.approvals.set",
    "exec.approvals.node.get",
    "exec.approvals.node.set",
  ],
  cron: [
    "cron.status",
    "cron.list",
    "cron.get",
    "cron.runs",
    "cron.add",
    "cron.update",
    "cron.remove",
    "cron.run",
  ],
  devices: ["device.pair.list", "device.pair.approve", "device.pair.reject", "device.pair.remove"],
  nodes: [
    "node.list",
    "node.describe",
    "node.pair.list",
    "node.pair.approve",
    "node.pair.reject",
    "node.pair.remove",
    "node.rename",
  ],
  diagnostics: ["doctor.memory.status", "update.status"],
} as const satisfies Record<string, readonly string[]>;

const ADMIN_HTTP_RPC_ALLOWED_METHODS: ReadonlySet<string> = new Set(
  Object.values(ADMIN_HTTP_RPC_ALLOWED_METHOD_GROUPS).flat(),
);

type RpcResponse =
  | { id: string; ok: true; payload: unknown; meta?: Record<string, unknown> }
  | { id: string; ok: false; error: GatewayMethodDispatchError; meta?: Record<string, unknown> };

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

function sendError(res: ServerResponse, status: number, error: { type: string; message: string }) {
  sendJson(res, status, { ok: false, error });
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

  const body = await readJsonBodyWithLimit(req, {
    // Admin responses are part of the client contract. The response-first profile
    // defers destruction so the transport owner can flush the JSON error.
    ...WEBHOOK_BODY_READ_DEFAULTS.postAuthResponseFirst,
    emptyObjectOnEmpty: false,
  });
  if (!body.ok) {
    const status =
      body.code === "PAYLOAD_TOO_LARGE" ? 413 : body.code === "REQUEST_BODY_TIMEOUT" ? 408 : 400;
    const message =
      body.code === "INVALID_JSON"
        ? body.error === "empty payload"
          ? "request body must be JSON"
          : "request body must be valid JSON"
        : body.error;
    if (body.code !== "INVALID_JSON" && body.code !== "CONNECTION_CLOSED") {
      if (!res.headersSent) {
        res.setHeader("Cache-Control", "no-store");
      }
      await sendHttpRequestRejection(
        req,
        res,
        status,
        JSON.stringify({ ok: false, error: { type: "invalid_request", message } }),
        "application/json; charset=utf-8",
      );
    } else {
      sendError(res, status, {
        type: "invalid_request",
        message,
      });
    }
    return true;
  }

  if (!isRecord(body.value)) {
    sendError(res, 400, {
      type: "invalid_request",
      message: "request body must be an object",
    });
    return true;
  }

  const method = normalizeOptionalString(body.value.method);
  if (!method) {
    sendError(res, 400, { type: "invalid_request", message: "method must be a non-empty string" });
    return true;
  }
  const id = normalizeOptionalString(body.value.id) ?? randomUUID();
  const params = Object.hasOwn(body.value, "params") ? body.value.params : undefined;
  if (!ADMIN_HTTP_RPC_ALLOWED_METHODS.has(method)) {
    sendJson(res, 400, {
      id,
      ok: false,
      error: {
        code: "INVALID_REQUEST",
        message: `admin HTTP RPC method is not supported: ${method}`,
      },
    });
    return true;
  }

  if (method === "commands.list") {
    sendJson(res, 200, {
      id,
      ok: true,
      payload: { methods: Array.from(ADMIN_HTTP_RPC_ALLOWED_METHODS) },
    });
    return true;
  }

  await getPluginRuntimeGatewayRequestScope()?.revalidate?.();
  const unavailable: GatewayMethodDispatchError = {
    code: "UNAVAILABLE",
    message: "gateway method failed before returning a response",
  };
  let response: RpcResponse;
  try {
    const result = await dispatchGatewayMethod(method, params);
    response = {
      id,
      ...(result.ok
        ? { ok: true as const, payload: result.payload }
        : { ok: false as const, error: result.error ?? unavailable }),
      ...(result.meta ? { meta: result.meta } : {}),
    };
  } catch {
    response = { id, ok: false, error: unavailable };
  }
  sendJson(res, rpcHttpStatus(response), response);
  return true;
}
