import { normalizeZulipBaseUrl } from "./normalize.js";

export type ZulipAuth = {
  baseUrl: string;
  email: string;
  apiKey: string;
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
    throw new Error(`Zulip API error (${res.status}): ${msg}`.trim());
  }
  return data as T;
}
