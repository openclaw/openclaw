import { randomUUID } from "node:crypto";

const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class HttpError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function isUuid(value) {
  return typeof value === "string" && uuidRegex.test(value);
}

export function lowerHeader(headers, name) {
  return headers[name.toLowerCase()];
}

export async function parseJsonBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const bodyText = Buffer.concat(chunks).toString("utf8");
  if (bodyText.trim() === "") {
    return {};
  }

  try {
    return JSON.parse(bodyText);
  } catch {
    throw new HttpError(400, "INVALID_JSON", "Request body must be valid JSON");
  }
}

export function sendJson(response, status, body) {
  const payload = JSON.stringify(body);
  response.statusCode = status;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.setHeader("content-length", Buffer.byteLength(payload).toString());
  response.end(payload);
}

export function errorBody(error, requestId = null) {
  return {
    error: {
      code: error.code ?? "INTERNAL_ERROR",
      message: error.message ?? "Internal server error",
      request_id: requestId,
      ...error.details,
    },
  };
}

export function requireHeader(headers, headerName, code, message) {
  const value = lowerHeader(headers, headerName);
  if (!value || value.trim() === "") {
    throw new HttpError(400, code, message);
  }
  return value.trim();
}

export function requireUuidField(value, fieldName) {
  if (!isUuid(value)) {
    throw new HttpError(400, "INVALID_REQUEST", `Field '${fieldName}' must be a valid UUID`);
  }
}

export function ensureObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpError(400, "INVALID_REQUEST", "Request body must be a JSON object");
  }
}

export function nowIso() {
  return new Date().toISOString();
}

export function buildCorrelationId(headers) {
  return lowerHeader(headers, "x-correlation-id")?.trim() ?? randomUUID();
}

export function buildTraceId(headers) {
  return lowerHeader(headers, "x-trace-id")?.trim() ?? null;
}

export function buildTraceContext(headers) {
  const traceParent = lowerHeader(headers, "traceparent")?.trim();
  const traceState = lowerHeader(headers, "tracestate")?.trim();
  const traceId = buildTraceId(headers);

  return {
    traceId: traceId && traceId !== "" ? traceId : null,
    traceParent: traceParent && traceParent !== "" ? traceParent : null,
    traceState: traceState && traceState !== "" ? traceState : null,
  };
}
