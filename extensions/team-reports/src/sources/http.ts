import { sleepWithAbort } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { z } from "zod";
import type { SourceRuntime, SourceStatus } from "../types.js";

export class ApiResponseReadError extends Error {
  constructor(readonly kind: "timeout" | "release") {
    super(kind);
  }
}

export async function readApiResponse(
  url: string | URL,
  headers: HeadersInit,
  runtime: SourceRuntime,
  status: SourceStatus,
  label: string,
): Promise<{ status: number; headers: Headers; data: unknown }> {
  const controller = new AbortController();
  const signal = runtime.signal
    ? AbortSignal.any([runtime.signal, controller.signal])
    : controller.signal;
  const timeout = setTimeout(() => controller.abort(), 30_000);
  let release: (() => Promise<void>) | undefined;
  try {
    checkAbort(runtime.signal, label);
    status.stats.apiCalls = Number(status.stats.apiCalls) + 1;
    const init: RequestInit = { headers, signal, redirect: "error" };
    let response: Response;
    if (runtime.fetchImpl) {
      response = await runtime.fetchImpl(url, init);
    } else {
      const result = await fetchWithSsrFGuard({
        url: String(url),
        init,
        signal: runtime.signal,
        timeoutMs: 30_000,
        requireHttps: true,
        maxRedirects: 0,
        capture: false,
      });
      response = result.response;
      release = result.release;
    }
    const body = await response.text();
    checkAbort(runtime.signal, label);
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      data = undefined;
    }
    return { status: response.status, headers: response.headers, data };
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiResponseReadError("timeout");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    await release?.().catch(() => {
      throw new ApiResponseReadError("release");
    });
  }
}

export function createResponseParser(createError: () => Error) {
  return <T>(schema: z.ZodType<T>, data: unknown): T => {
    const parsed = schema.safeParse(data);
    if (!parsed.success) {
      throw createError();
    }
    return parsed.data;
  };
}

export function checkAbort(signal: AbortSignal | undefined, label: string): void {
  if (signal?.aborted) {
    // Abort reasons and transport errors may contain credentials supplied by callers.
    throw new DOMException(label, "AbortError");
  }
}

export async function wait(
  ms: number,
  signal: AbortSignal | undefined,
  label: string,
): Promise<void> {
  checkAbort(signal, label);
  try {
    await sleepWithAbort(ms, signal);
  } catch (error) {
    checkAbort(signal, label);
    throw error;
  }
  checkAbort(signal, label);
}

export function parseApiBase(raw: string, label: string): URL {
  const base = URL.parse(`${raw.replace(/\/+$/, "")}/`);
  if (!base) {
    throw new Error(`${label} API base URL is invalid.`);
  }
  if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash) {
    throw new Error(
      `${label} API base URL must use HTTPS without credentials, query, or fragment.`,
    );
  }
  return base;
}
