import { readErrorName } from "openclaw/plugin-sdk/error-runtime";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import type { z } from "zod";
import { MAX_API_RESPONSE_BYTES, formatApiResponseSize } from "../limits.js";
import type { SourceStatus } from "../types.js";

export class ApiResponseReadError extends Error {
  constructor(
    readonly kind: "timeout" | "release" | "too-large",
    /** Bytes read before the cutoff tripped, recorded so the warning can describe the read. */
    readonly size?: number,
    /** Size the host advertised, which names the real page size when the response declares one. */
    readonly declared?: number,
  ) {
    super(kind);
  }
}

/** Overflow detail both sources append, so the warning names the cutoff and what arrived. */
export function describeResponseOverflow(error: ApiResponseReadError): string {
  if (error.declared !== undefined) {
    return ` (host declared ${formatApiResponseSize(error.declared)})`;
  }
  return error.size === undefined
    ? ""
    : ` (read ${formatApiResponseSize(error.size)} before the cutoff)`;
}

function declaredResponseBytes(response: Response): number | undefined {
  const header = response.headers.get("content-length");
  if (header === null) {
    return undefined;
  }
  const bytes = Number(header);
  return Number.isSafeInteger(bytes) && bytes > 0 ? bytes : undefined;
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
    const body = await readResponseWithLimit(response, MAX_API_RESPONSE_BYTES, {
      onOverflow: ({ size }) => {
        const declared = declaredResponseBytes(response);
        // An encoded response declares its transferred length, which is below what we decoded.
        return new ApiResponseReadError(
          "too-large",
          size,
          declared !== undefined && declared >= size ? declared : undefined,
        );
      },
    });
    let data: unknown;
    try {
      data = JSON.parse(body.toString("utf8"));
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
