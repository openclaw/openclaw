import { randomUUID } from "node:crypto";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ACTOR_TYPES = new Set(["HUMAN", "AGENT", "SERVICE", "SYSTEM"]);
const DEFAULT_TIMEOUT_MS = 10_000;

export const TOOL_SPECS = Object.freeze({
  "ticket.create": Object.freeze({
    tool_name: "ticket.create",
    method: "POST",
    endpoint: "/tickets",
    requires_ticket_id: false,
    mutating: true,
    allowed_roles: Object.freeze(["dispatcher", "agent"]),
  }),
  "ticket.triage": Object.freeze({
    tool_name: "ticket.triage",
    method: "POST",
    endpoint: "/tickets/{ticketId}/triage",
    requires_ticket_id: true,
    mutating: true,
    allowed_roles: Object.freeze(["dispatcher", "agent"]),
  }),
  "schedule.confirm": Object.freeze({
    tool_name: "schedule.confirm",
    method: "POST",
    endpoint: "/tickets/{ticketId}/schedule/confirm",
    requires_ticket_id: true,
    mutating: true,
    allowed_roles: Object.freeze(["dispatcher", "customer"]),
  }),
  "assignment.dispatch": Object.freeze({
    tool_name: "assignment.dispatch",
    method: "POST",
    endpoint: "/tickets/{ticketId}/assignment/dispatch",
    requires_ticket_id: true,
    mutating: true,
    allowed_roles: Object.freeze(["dispatcher"]),
  }),
  "ticket.timeline": Object.freeze({
    tool_name: "ticket.timeline",
    method: "GET",
    endpoint: "/tickets/{ticketId}/timeline",
    requires_ticket_id: true,
    mutating: false,
    allowed_roles: Object.freeze([
      "dispatcher",
      "agent",
      "customer",
      "tech",
      "qa",
      "approver",
      "finance",
    ]),
  }),
});

export class DispatchBridgeError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "DispatchBridgeError";
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toObject() {
    return {
      error: {
        code: this.code,
        status: this.status,
        message: this.message,
        ...this.details,
      },
    };
  }
}

export function isUuid(value) {
  return typeof value === "string" && UUID_REGEX.test(value);
}

function ensureObject(value, fieldName) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new DispatchBridgeError(400, "INVALID_REQUEST", `Field '${fieldName}' must be an object`);
  }
}

function readNonEmptyString(value, fieldName) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new DispatchBridgeError(400, "INVALID_REQUEST", `Field '${fieldName}' is required`);
  }
  return value.trim();
}

function normalizeActorType(value) {
  if (value == null) {
    return "AGENT";
  }
  const normalized = readNonEmptyString(value, "actor_type").toUpperCase();
  if (!ACTOR_TYPES.has(normalized)) {
    throw new DispatchBridgeError(400, "INVALID_REQUEST", "Field 'actor_type' is invalid");
  }
  return normalized;
}

function normalizeBaseUrl(baseUrl) {
  const normalized = readNonEmptyString(baseUrl, "baseUrl");
  return normalized.replace(/\/+$/, "");
}

function normalizeTimeoutMs(timeoutMs) {
  if (timeoutMs == null) {
    return DEFAULT_TIMEOUT_MS;
  }
  if (typeof timeoutMs !== "number" || !Number.isFinite(timeoutMs) || timeoutMs < 100) {
    throw new DispatchBridgeError(400, "INVALID_REQUEST", "Field 'timeoutMs' must be >= 100");
  }
  return Math.floor(timeoutMs);
}

function resolveRequestId(requestId) {
  if (requestId == null || requestId === "") {
    return randomUUID();
  }
  const normalized = readNonEmptyString(requestId, "request_id");
  if (!isUuid(normalized)) {
    throw new DispatchBridgeError(400, "INVALID_REQUEST", "Field 'request_id' must be a UUID");
  }
  return normalized;
}

function resolveCorrelationId(correlationId) {
  if (correlationId == null || correlationId === "") {
    return randomUUID();
  }
  return readNonEmptyString(correlationId, "correlation_id");
}

function resolveTraceId(traceId) {
  if (traceId == null || traceId === "") {
    return null;
  }
  return readNonEmptyString(traceId, "trace_id");
}

function resolveToolSpec(toolName) {
  const normalized = readNonEmptyString(toolName, "tool_name");
  const spec = TOOL_SPECS[normalized];
  if (!spec) {
    throw new DispatchBridgeError(400, "UNKNOWN_TOOL", "Tool is not allowlisted", {
      tool_name: normalized,
    });
  }
  return spec;
}

function resolveTicketId(spec, ticketId) {
  if (!spec.requires_ticket_id) {
    return null;
  }
  const normalized = readNonEmptyString(ticketId, "ticket_id");
  if (!isUuid(normalized)) {
    throw new DispatchBridgeError(400, "INVALID_TICKET_ID", "Field 'ticket_id' must be a UUID", {
      tool_name: spec.tool_name,
    });
  }
  return normalized;
}

function resolveActorRole(spec, actorRole) {
  const normalized = readNonEmptyString(actorRole, "actor_role").toLowerCase();
  if (!spec.allowed_roles.includes(normalized)) {
    throw new DispatchBridgeError(403, "TOOL_ROLE_FORBIDDEN", "Actor role is not allowed for tool", {
      tool_name: spec.tool_name,
      actor_role: normalized,
    });
  }
  return normalized;
}

function resolveEndpoint(spec, ticketId) {
  if (!spec.requires_ticket_id) {
    return spec.endpoint;
  }
  return spec.endpoint.replace("{ticketId}", ticketId);
}

function parseJsonOrText(text) {
  if (!text || text.trim() === "") {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

function logInfo(logger, payload) {
  if (logger && typeof logger.info === "function") {
    logger.info(JSON.stringify(payload));
  }
}

function logError(logger, payload) {
  if (logger && typeof logger.error === "function") {
    logger.error(JSON.stringify(payload));
    return;
  }
  if (logger && typeof logger.warn === "function") {
    logger.warn(JSON.stringify(payload));
  }
}

export async function invokeDispatchAction(params) {
  ensureObject(params, "params");

  const spec = resolveToolSpec(params.toolName);
  const actorId = readNonEmptyString(params.actorId, "actor_id");
  const actorRole = resolveActorRole(spec, params.actorRole);
  const actorType = normalizeActorType(params.actorType);
  const requestId = resolveRequestId(params.requestId);
  const correlationId = resolveCorrelationId(params.correlationId);
  const traceId = resolveTraceId(params.traceId);
  const ticketId = resolveTicketId(spec, params.ticketId);
  const endpoint = resolveEndpoint(spec, ticketId);
  const baseUrl = normalizeBaseUrl(params.baseUrl);
  const timeoutMs = normalizeTimeoutMs(params.timeoutMs);
  const logger = params.logger ?? null;

  const fetchImpl = params.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new DispatchBridgeError(500, "DISPATCH_API_UNREACHABLE", "Fetch implementation is not available", {
      tool_name: spec.tool_name,
      request_id: requestId,
      correlation_id: correlationId,
    });
  }

  const headers = {
    accept: "application/json",
    "x-correlation-id": correlationId,
  };

  if (traceId) {
    headers["x-trace-id"] = traceId;
  }

  if (typeof params.token === "string" && params.token.trim()) {
    headers.authorization = `Bearer ${params.token.trim()}`;
  }

  let body;
  if (spec.mutating) {
    ensureObject(params.payload, "payload");
    headers["content-type"] = "application/json";
    headers["idempotency-key"] = requestId;
    headers["x-actor-id"] = actorId;
    headers["x-actor-role"] = actorRole;
    headers["x-actor-type"] = actorType;
    headers["x-tool-name"] = spec.tool_name;
    body = JSON.stringify(params.payload);
  }

  const url = `${baseUrl}${endpoint}`;
  const controller = new AbortController();
  const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

  logInfo(logger, {
    level: "info",
    component: "dispatch-tool-bridge",
    phase: "request",
    tool_name: spec.tool_name,
    endpoint,
    request_id: requestId,
    correlation_id: correlationId,
    actor_id: actorId,
    actor_role: actorRole,
  });

  try {
    const response = await fetchImpl(url, {
      method: spec.method,
      headers,
      body,
      signal: controller.signal,
    });

    const responseText = await response.text();
    const parsedBody = parseJsonOrText(responseText);

    logInfo(logger, {
      level: "info",
      component: "dispatch-tool-bridge",
      phase: "response",
      tool_name: spec.tool_name,
      endpoint,
      request_id: requestId,
      correlation_id: correlationId,
      status: response.status,
    });

    if (response.status >= 400) {
      throw new DispatchBridgeError(response.status, "DISPATCH_API_ERROR", "dispatch-api rejected tool request", {
        tool_name: spec.tool_name,
        endpoint,
        request_id: requestId,
        correlation_id: correlationId,
        dispatch_error: parsedBody,
      });
    }

    return {
      tool_name: spec.tool_name,
      endpoint,
      request_id: requestId,
      correlation_id: correlationId,
      status: response.status,
      data: parsedBody,
    };
  } catch (error) {
    if (error instanceof DispatchBridgeError) {
      logError(logger, {
        level: "error",
        component: "dispatch-tool-bridge",
        phase: "response",
        tool_name: spec.tool_name,
        endpoint,
        request_id: requestId,
        correlation_id: correlationId,
        code: error.code,
        status: error.status,
        message: error.message,
      });
      throw error;
    }

    if (error?.name === "AbortError") {
      const timeoutError = new DispatchBridgeError(504, "DISPATCH_API_TIMEOUT", "dispatch-api request timed out", {
        tool_name: spec.tool_name,
        endpoint,
        request_id: requestId,
        correlation_id: correlationId,
      });
      logError(logger, {
        level: "error",
        component: "dispatch-tool-bridge",
        phase: "response",
        tool_name: spec.tool_name,
        endpoint,
        request_id: requestId,
        correlation_id: correlationId,
        code: timeoutError.code,
        status: timeoutError.status,
        message: timeoutError.message,
      });
      throw timeoutError;
    }

    const unreachable = new DispatchBridgeError(502, "DISPATCH_API_UNREACHABLE", "dispatch-api request failed", {
      tool_name: spec.tool_name,
      endpoint,
      request_id: requestId,
      correlation_id: correlationId,
      reason: error instanceof Error ? error.message : String(error),
    });

    logError(logger, {
      level: "error",
      component: "dispatch-tool-bridge",
      phase: "response",
      tool_name: spec.tool_name,
      endpoint,
      request_id: requestId,
      correlation_id: correlationId,
      code: unreachable.code,
      status: unreachable.status,
      message: unreachable.message,
      reason: unreachable.details.reason,
    });

    throw unreachable;
  } finally {
    clearTimeout(timeoutHandle);
  }
}
