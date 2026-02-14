import { normalizeZulipBaseUrl } from "./normalize.js";

export type ZulipAuth = {
  baseUrl: string;
  email: string;
  apiKey: string;
};

export type ZulipHttpError = Error & {
  status?: number;
  retryAfterMs?: number;
};

export type ZulipApiError = {
  result: "error";
  msg?: string;
  code?: string;
};

export type ZulipApiSuccess = {
  result: "success";
  msg?: string;
};

function buildAuthHeader(email: string, apiKey: string): string {
  const token = Buffer.from(`${email}:${apiKey}`, "utf8").toString("base64");
  return `Basic ${token}`;
}

function sleep(ms: number, abortSignal?: AbortSignal): Promise<void> {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    abortSignal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      },
      { once: true },
    );
  });
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { result: "error", msg: `Invalid JSON response (status ${res.status})` };
  }
}

export async function zulipRequest<T = unknown>(params: {
  auth: ZulipAuth;
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  form?: Record<string, string | number | boolean | undefined>;
  abortSignal?: AbortSignal;
}): Promise<T> {
  const baseUrl = normalizeZulipBaseUrl(params.auth.baseUrl);
  if (!baseUrl) {
    throw new Error("Missing Zulip baseUrl");
  }
  const url = new URL(`${baseUrl}${params.path.startsWith("/") ? "" : "/"}${params.path}`);
  for (const [key, value] of Object.entries(params.query ?? {})) {
    if (value === undefined) {
      continue;
    }
    url.searchParams.set(key, String(value));
  }

  const headers: Record<string, string> = {
    Authorization: buildAuthHeader(params.auth.email, params.auth.apiKey),
  };
  let body: string | undefined;
  if (params.form) {
    const form = new URLSearchParams();
    for (const [key, value] of Object.entries(params.form)) {
      if (value === undefined) {
        continue;
      }
      form.set(key, String(value));
    }
    body = form.toString();
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  }

  const res = await fetch(url, {
    method: params.method,
    headers,
    body,
    signal: params.abortSignal,
  });

  const data = await readJson(res);
  if (!res.ok) {
    const retryAfterRaw = res.headers.get("retry-after");
    const retryAfterSeconds = retryAfterRaw ? Number(retryAfterRaw) : null;
    const retryAfterMs =
      retryAfterSeconds != null && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
        ? Math.floor(retryAfterSeconds * 1000)
        : undefined;
    const msgValue =
      data && typeof data === "object" && "msg" in (data as Record<string, unknown>)
        ? (data as { msg?: unknown }).msg
        : undefined;
    const msg =
      typeof msgValue === "string"
        ? msgValue
        : msgValue != null
          ? JSON.stringify(msgValue)
          : `HTTP ${res.status}`;
    const err: ZulipHttpError = new Error(`Zulip API error (${res.status}): ${msg}`.trim());
    err.status = res.status;
    err.retryAfterMs = retryAfterMs;
    throw err;
  }
  return data as T;
}

export async function zulipRequestWithRetry<T = unknown>(
  params: Parameters<typeof zulipRequest<T>>[0] & {
    retry?: {
      maxRetries?: number;
      baseDelayMs?: number;
      maxDelayMs?: number;
    };
  },
): Promise<T> {
  const maxRetries = params.retry?.maxRetries ?? 4;
  const baseDelayMs = params.retry?.baseDelayMs ?? 750;
  const maxDelayMs = params.retry?.maxDelayMs ?? 15_000;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      return await zulipRequest<T>(params);
    } catch (err) {
      const status = (err as ZulipHttpError).status;
      const retryAfterMs = (err as ZulipHttpError).retryAfterMs;
      const isRetryable = status === 429 || status === 503 || status === 502 || status === 504;
      if (!isRetryable || attempt >= maxRetries) {
        throw err;
      }
      const expDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = Math.floor(Math.random() * 250);
      const delayMs = Math.max(expDelay + jitter, retryAfterMs ?? 0);
      attempt += 1;
      await sleep(delayMs, params.abortSignal).catch(() => undefined);
    }
  }
}
