import { randomUUID } from "crypto";
import { NextResponse } from "next/server";

/**
 * Production-safe error handling utilities.
 * Logs full errors server-side, returns sanitized messages to clients.
 */

const IS_PRODUCTION = process.env.NODE_ENV === "production";

export interface ApiErrorOptions {
  message: string;
  status?: number;
  code?: string;
  details?: unknown;
  requestId?: string;
  headers?: HeadersInit;
}

export function ensureRequestId(candidate?: string | null): string {
  const value = candidate?.trim();
  if (value) {return value;}
  return randomUUID();
}

export function attachRequestIdHeader<T extends Response>(
  response: T,
  requestId?: string
): T {
  const resolved = ensureRequestId(requestId);
  if (!response.headers.has("X-Request-Id")) {
    response.headers.set("X-Request-Id", resolved);
  }
  return response;
}

export function apiErrorResponse(options: ApiErrorOptions): NextResponse {
  const status = options.status ?? 500;
  const code = options.code ?? "INTERNAL_ERROR";
  const requestId = ensureRequestId(options.requestId);

  const payload: Record<string, unknown> = {
    ok: false,
    error: options.message,
    errorCode: code,
    errorInfo: {
      code,
      message: options.message,
      requestId,
    },
  };

  if (!IS_PRODUCTION && options.details !== undefined) {
    payload.details = options.details;
    (payload.errorInfo as Record<string, unknown>).details = options.details;
  }

  const response = NextResponse.json(payload, {
    status,
    headers: options.headers,
  });
  response.headers.set("X-Request-Id", requestId);
  return response;
}

/**
 * Log error securely (full details server-side only).
 */
export function logError(context: string, error: unknown): void {
  const timestamp = new Date().toISOString();
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;

  console.error(`[${timestamp}] [${context}] Error:`, message);
  if (stack && !IS_PRODUCTION) {
    console.error(stack);
  }
}

/**
 * Create a safe error response that doesn't leak implementation details.
 */
export function safeErrorResponse(
  userMessage: string,
  error: unknown,
  status: number = 500,
  requestId?: string,
  errorCode = "INTERNAL_ERROR"
): NextResponse {
  // Log full error server-side
  logError(userMessage, error);
  return apiErrorResponse({
    message: userMessage,
    status,
    code: errorCode,
    details: error instanceof Error ? error.message : String(error),
    requestId,
  });
}

/**
 * Known error types that are safe to expose to users.
 */
export class UserError extends Error {
  constructor(
    message: string,
    public statusCode: number = 400,
    public errorCode: string = "BAD_REQUEST"
  ) {
    super(message);
    this.name = "UserError";
  }
}

function resolveSystemErrorMetadata(error: unknown): {
  status: number;
  code: string;
} {
  const message = toErrorText(error);

  if (
    message.includes("gateway connection") ||
    message.includes("websocket connection closed") ||
    message.includes("connection timeout") ||
    message.includes("connect econnrefused")
  ) {
    return { status: 503, code: "GATEWAY_UNAVAILABLE" };
  }

  if (message.includes("too many requests") || message.includes("rate limit")) {
    return { status: 429, code: "RATE_LIMITED" };
  }

  if (message.includes("csrf")) {
    return { status: 403, code: "CSRF_REJECTED" };
  }

  return { status: 500, code: "INTERNAL_ERROR" };
}

function toErrorText(error: unknown): string {
  return error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
}

export function isGatewayUnavailableError(error: unknown): boolean {
  const message = toErrorText(error);
  return (
    message.includes("gateway connection") ||
    message.includes("websocket connection closed") ||
    message.includes("websocket was closed before the connection was established") ||
    message.includes("websocket is not open") ||
    message.includes("connect econnrefused") ||
    message.includes("connection timeout")
  );
}

export function isGatewayUnsupportedMethodError(
  error: unknown,
  method?: string
): boolean {
  const message = toErrorText(error);
  if (!message.includes("unknown method")) {return false;}
  if (!method) {return true;}
  return message.includes(method.toLowerCase());
}

/**
 * Handle errors uniformly, distinguishing user errors from system errors.
 */
export function handleApiError(
  error: unknown,
  fallbackMessage: string = "An unexpected error occurred",
  requestId?: string
): NextResponse {
  if (error instanceof UserError) {
    return apiErrorResponse({
      message: error.message,
      status: error.statusCode,
      code: error.errorCode,
      requestId,
    });
  }
  const meta = resolveSystemErrorMetadata(error);
  return safeErrorResponse(
    fallbackMessage,
    error,
    meta.status,
    requestId,
    meta.code
  );
}
