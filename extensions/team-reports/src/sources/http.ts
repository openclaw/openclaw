import { readErrorName } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { z } from "zod";
import type { SourceStatus } from "../types.js";

export class ApiResponseReadError extends Error {
  constructor(readonly kind: "timeout" | "release") {
    super(kind);
  }
}

export async function readApiResponse(
  url: string | URL,
  headers: HeadersInit,
  status: SourceStatus,
): Promise<{ status: number; headers: Headers; data: unknown }> {
  let release: (() => Promise<void>) | undefined;
  try {
    status.stats.apiCalls = Number(status.stats.apiCalls) + 1;
    const init: RequestInit = { headers, redirect: "error" };
    const result = await fetchWithSsrFGuard({
      url: String(url),
      init,
      timeoutMs: 30_000,
      requireHttps: true,
      maxRedirects: 0,
      capture: false,
    });
    const response = result.response;
    release = result.release;
    const body = await response.text();
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      data = undefined;
    }
    return { status: response.status, headers: response.headers, data };
  } catch (error) {
    const name = readErrorName(error);
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ApiResponseReadError("timeout");
    }
    throw error;
  } finally {
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
