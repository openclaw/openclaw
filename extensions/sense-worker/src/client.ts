export type SenseClientConfig = {
  baseUrl?: string;
  timeoutMs?: number;
  token?: string;
  tokenEnv?: string;
  logger?: {
    debug?: (...args: unknown[]) => void;
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
};

export type SenseExecutePayload = {
  task: string;
  input: string;
  params: Record<string, unknown>;
};

export type SenseCallResult = {
  ok: boolean;
  status: number;
  url: string;
  body: unknown;
};

const DEFAULT_BASE_URL = "http://192.168.11.11:8787";
const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_TOKEN_ENV = "SENSE_WORKER_TOKEN";

function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function buildUrl(baseUrl: string, path: string): string {
  return `${trimTrailingSlash(baseUrl)}${path.startsWith("/") ? path : `/${path}`}`;
}

async function fetchJson(params: {
  method: "GET" | "POST";
  url: string;
  timeoutMs: number;
  token?: string;
  body?: unknown;
  logger?: SenseClientConfig["logger"];
}): Promise<SenseCallResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Math.max(100, params.timeoutMs));
  const startedAt = Date.now();
  try {
    params.logger?.info?.(
      `[sense-worker] request method=${params.method} url=${params.url} body=${params.body ? "yes" : "no"}`,
    );
    const headers: Record<string, string> = {
      Accept: "application/json",
    };
    if (params.body) {
      headers["Content-Type"] = "application/json";
    }
    if (params.token) {
      headers["X-Sense-Worker-Token"] = params.token;
    }
    const response = await fetch(params.url, {
      method: params.method,
      headers,
      body: params.body ? JSON.stringify(params.body) : undefined,
      signal: ctrl.signal,
    });
    const raw = await response.text();
    let parsed: unknown;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      throw new Error(`Sense worker returned invalid JSON (status ${response.status})`);
    }
    const elapsedMs = Date.now() - startedAt;
    params.logger?.info?.(
      `[sense-worker] response method=${params.method} status=${response.status} elapsed_ms=${elapsedMs}`,
    );
    return {
      ok: response.ok,
      status: response.status,
      url: params.url,
      body: parsed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === "AbortError") {
      params.logger?.warn?.(
        `[sense-worker] timeout method=${params.method} url=${params.url} timeout_ms=${params.timeoutMs}`,
      );
      throw new Error(`Sense worker request timed out after ${params.timeoutMs}ms`);
    }
    params.logger?.error?.(
      `[sense-worker] request failed method=${params.method} url=${params.url}: ${message}`,
    );
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function resolveToken(config: SenseClientConfig): string | undefined {
  if (typeof config.token === "string" && config.token.trim()) {
    return config.token.trim();
  }
  const envName =
    typeof config.tokenEnv === "string" && config.tokenEnv.trim()
      ? config.tokenEnv.trim()
      : DEFAULT_TOKEN_ENV;
  const value = process.env[envName];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function checkSenseHealth(config: SenseClientConfig = {}): Promise<SenseCallResult> {
  const baseUrl = config.baseUrl?.trim() || DEFAULT_BASE_URL;
  return await fetchJson({
    method: "GET",
    url: buildUrl(baseUrl, "/health"),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    token: resolveToken(config),
    logger: config.logger,
  });
}

export async function callSense(
  task: string,
  input: string,
  params: Record<string, unknown> = {},
  config: SenseClientConfig = {},
): Promise<SenseCallResult> {
  if (!task.trim()) {
    throw new Error("task required");
  }
  const baseUrl = config.baseUrl?.trim() || DEFAULT_BASE_URL;
  const payload: SenseExecutePayload = {
    task: task.trim(),
    input,
    params,
  };
  return await fetchJson({
    method: "POST",
    url: buildUrl(baseUrl, "/execute"),
    timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    token: resolveToken(config),
    body: payload,
    logger: config.logger,
  });
}

export const __testing = {
  DEFAULT_BASE_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_TOKEN_ENV,
  resolveToken,
};
