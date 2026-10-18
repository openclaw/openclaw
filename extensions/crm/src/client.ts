import type { CrmConfig } from "./config.js";

export type CrmMethod = "GET" | "POST" | "PATCH" | "DELETE";

export type CrmRequestOptions = {
  method: CrmMethod;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
};

const MAX_ERROR_BODY_CHARS = 2_000;

export class CrmApiError extends Error {
  readonly status: number;
  readonly payload: unknown;

  constructor(status: number, message: string, payload: unknown) {
    super(message);
    this.name = "CrmApiError";
    this.status = status;
    this.payload = payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseJson(text: string): unknown {
  if (!text.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function readErrorMessage(payload: unknown, fallback: string): string {
  if (isRecord(payload)) {
    for (const candidate of [
      payload.message,
      isRecord(payload.error) ? payload.error.message : payload.error,
      isRecord(payload.data) ? payload.data.message : undefined,
    ]) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }

  const text = fallback.trim();
  return text ? text.slice(0, MAX_ERROR_BODY_CHARS) : "empty response";
}

function formatApiError(
  status: number,
  payload: unknown,
  responseText: string,
  method: CrmMethod,
  path: string,
): string {
  const detail = readErrorMessage(payload, responseText);
  if (status === 401 || status === 403) {
    return (
      `CRM API rejected ${method} ${path} (${status}): ${detail} ` +
      "Create an API key in the CRM under Settings → API keys and set " +
      "plugins.entries.crm.config.apiKey (or CRM_API_KEY)."
    );
  }
  return `CRM API request failed (${status}) for ${method} ${path}: ${detail}`;
}

export function buildCrmUrl(
  config: Pick<CrmConfig, "baseUrl">,
  path: string,
  query?: CrmRequestOptions["query"],
): URL {
  const base = config.baseUrl.replace(/\/+$/u, "");
  const suffix = path.startsWith("/") ? path : `/${path}`;
  const url = new URL(`${base}/rest${suffix}`);

  for (const [key, value] of Object.entries(query ?? {})) {
    if (value === undefined || value === "") {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  return url;
}

export async function crmRequest<T>(config: CrmConfig, options: CrmRequestOptions): Promise<T> {
  options.signal?.throwIfAborted();

  const controller = new AbortController();
  const timeoutMs = config.timeoutSeconds * 1_000;
  const timeout = setTimeout(() => {
    controller.abort(new Error(`CRM request timed out after ${config.timeoutSeconds}s.`));
  }, timeoutMs);
  const forwardAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener("abort", forwardAbort, { once: true });

  try {
    const headers: Record<string, string> = {
      accept: "application/json",
      "x-api-key": config.apiKey,
    };
    if (options.body !== undefined) {
      headers["content-type"] = "application/json";
    }

    const response = await fetch(buildCrmUrl(config, options.path, options.query), {
      method: options.method,
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      signal: controller.signal,
    });
    const responseText = await response.text();
    options.signal?.throwIfAborted();

    const payload = parseJson(responseText);
    if (!response.ok) {
      throw new CrmApiError(
        response.status,
        formatApiError(response.status, payload, responseText, options.method, options.path),
        payload,
      );
    }

    return payload as T;
  } catch (error) {
    if (error instanceof CrmApiError) {
      throw error;
    }
    if (options.signal?.aborted) {
      throw options.signal.reason ?? error;
    }
    if (controller.signal.aborted) {
      throw new Error(`CRM API request timed out after ${config.timeoutSeconds}s.`, {
        cause: error,
      });
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not reach the CRM API at ${config.baseUrl}: ${detail}`, {
      cause: error,
    });
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", forwardAbort);
  }
}
