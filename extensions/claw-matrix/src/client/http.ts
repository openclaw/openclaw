import crypto from "node:crypto";
import type { MatrixError } from "../types.js";
import { incrementCounter } from "../health.js";
import { TokenBucket } from "../util/rate-limit.js";

// SINGLETON: multi-account requires refactoring this to per-account state
const httpRateLimiter = new TokenBucket(10, 2);

export class MatrixApiError extends Error {
  constructor(
    public readonly errcode: string,
    message: string,
    public readonly statusCode: number,
    public readonly softLogout?: boolean,
  ) {
    super(`${errcode}: ${message}`);
    this.name = "MatrixApiError";
  }
}

/**
 * Thrown when a request times out (AbortError from fetch).
 * Not a server error — should not count as a consecutive failure in the sync loop.
 */
export class MatrixTimeoutError extends Error {
  constructor(method: string, path: string, timeoutMs: number) {
    super(`Request timed out: ${method} ${path} (${timeoutMs}ms)`);
    this.name = "MatrixTimeoutError";
  }
}

/**
 * Thrown when a request fails due to a network error (DNS, connection refused, etc).
 */
export class MatrixNetworkError extends Error {
  constructor(method: string, path: string, cause: string) {
    super(`Network error: ${method} ${path}: ${cause}`);
    this.name = "MatrixNetworkError";
  }
}

export interface MatrixHttpClient {
  homeserver: string;
  accessToken: string;
}

// SINGLETON: multi-account requires refactoring this to per-account state
let _client: MatrixHttpClient | null = null;

export function initHttpClient(homeserver: string, accessToken: string): void {
  _client = {
    homeserver: homeserver.replace(/\/+$/, ""),
    accessToken,
  };
}

export function updateAccessToken(token: string): void {
  if (_client) _client.accessToken = token;
}

export function getClient(): MatrixHttpClient {
  if (!_client) throw new Error("Matrix HTTP client not initialized");
  return _client;
}

/**
 * Make an authenticated request to the Matrix homeserver.
 * Auth via Authorization header (never query param — deprecated v1.11).
 */
export async function matrixFetch<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts?: { timeoutMs?: number; noAuth?: boolean; skipRateLimit?: boolean },
): Promise<T> {
  if (!opts?.skipRateLimit) {
    await httpRateLimiter.acquire();
  }

  const client = getClient();
  const url = `${client.homeserver}${path}`;
  const headers: Record<string, string> = {};

  if (!opts?.noAuth) {
    headers["Authorization"] = `Bearer ${client.accessToken}`;
  }

  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  const jsonBody = body !== undefined ? JSON.stringify(body) : undefined;

  const result = await doFetch<T>(method, url, headers, jsonBody, opts?.timeoutMs ?? 30_000);

  // 429 retry: parse Retry-After, wait, retry once
  if (result.status === 429) {
    incrementCounter("rateLimitHits");
    const retryAfter = result.retryAfterMs ?? 1000;
    console.warn(`[http] 429 rate-limited on ${method} ${path}, retrying after ${retryAfter}ms`);
    await new Promise((r) => setTimeout(r, retryAfter));
    const retry = await doFetch<T>(method, url, headers, jsonBody, opts?.timeoutMs ?? 30_000);
    return handleResponse<T>(retry.response, retry.responseText, retry.status);
  }

  return handleResponse<T>(result.response, result.responseText, result.status);
}

async function doFetch<T>(
  method: string,
  url: string,
  headers: Record<string, string>,
  jsonBody: string | undefined,
  timeoutMs: number,
): Promise<{ response: Response; responseText: string; status: number; retryAfterMs?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // Extract path from URL for error messages
  let pathForError: string;
  try {
    pathForError = new URL(url).pathname;
  } catch {
    pathForError = url;
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: jsonBody,
      signal: controller.signal,
    });

    const responseText = await response.text();
    let retryAfterMs: number | undefined;

    if (response.status === 429) {
      const retryHeader = response.headers.get("Retry-After");
      if (retryHeader) {
        const secs = Number(retryHeader);
        retryAfterMs = Number.isFinite(secs) ? secs * 1000 : 1000;
      } else {
        // Check Matrix JSON retry_after_ms field
        try {
          const parsed = JSON.parse(responseText);
          if (parsed.retry_after_ms) retryAfterMs = parsed.retry_after_ms;
        } catch {}
      }
    }

    return { response, responseText, status: response.status, retryAfterMs };
  } catch (err: any) {
    // Distinguish timeout from network errors
    if (err.name === "AbortError") {
      throw new MatrixTimeoutError(method, pathForError, timeoutMs);
    }
    throw new MatrixNetworkError(method, pathForError, err.message ?? String(err));
  } finally {
    clearTimeout(timer);
  }
}

function handleResponse<T>(response: Response, responseText: string, status: number): T {
  let responseJson: any;

  try {
    responseJson = JSON.parse(responseText);
  } catch {
    if (!response.ok) {
      throw new MatrixApiError(
        "M_UNKNOWN",
        `HTTP ${status}: ${responseText.slice(0, 200)}`,
        status,
      );
    }
    return responseText as unknown as T;
  }

  if (!response.ok) {
    const err = responseJson as MatrixError;
    throw new MatrixApiError(
      err.errcode ?? "M_UNKNOWN",
      err.error ?? `HTTP ${status}`,
      status,
      err.soft_logout,
    );
  }

  return responseJson as T;
}

/**
 * Generate a transaction ID for PUT sends (device-scoped per v1.7).
 */
export function txnId(): string {
  return crypto.randomUUID();
}
