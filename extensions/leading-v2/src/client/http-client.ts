import type { BackendConfig, MySqlConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://v2.businesstimescn.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_SITE_ID = "legal";

/** Resolve config from plugin config, falling back to env then defaults. */
export function resolveConfig(pluginConfig: Record<string, unknown>): BackendConfig {
  const block = pluginConfig.backend as Record<string, unknown> | undefined;
  const baseUrl = ((block?.baseUrl as string) ?? process.env.LEADING_API_BASE_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const timeoutMs = Number(
    block?.timeoutMs ?? process.env.LEADING_API_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  const siteId =
    ((block?.siteId as string) ?? process.env.LEADING_API_SITE_ID ?? DEFAULT_SITE_ID).trim() ||
    DEFAULT_SITE_ID;
  const rawKeys = (block?.apiKeys as Record<string, unknown> | undefined) ?? {};
  const apiKeys: Record<string, string> = {};
  for (const [uid, key] of Object.entries(rawKeys)) {
    if (typeof key === "string" && key.trim()) {
      apiKeys[uid] = key.trim();
    }
  }

  const dbBlock = block?.db as Record<string, unknown> | undefined;
  const db: MySqlConfig | undefined =
    dbBlock || process.env.WRITER_MYSQL_HOST
      ? {
          host: (dbBlock?.host as string) ?? process.env.WRITER_MYSQL_HOST ?? "127.0.0.1",
          port: Number(dbBlock?.port ?? process.env.WRITER_MYSQL_PORT ?? 3306),
          user: (dbBlock?.user as string) ?? process.env.WRITER_MYSQL_USER ?? "",
          password: (dbBlock?.password as string) ?? process.env.WRITER_MYSQL_PASSWORD ?? "",
          database:
            (dbBlock?.database as string) ?? process.env.WRITER_MYSQL_DATABASE ?? "superworker",
        }
      : undefined;

  return {
    baseUrl,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
    siteId,
    apiKeys,
    db,
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl}/${path.replace(/^\/+/, "")}`;
}

/** Thrown for non-2xx responses or bodies that are not parseable JSON. */
export class BackendApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "BackendApiError";
    this.status = status;
  }
}

function parseJsonOrThrow(text: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new BackendApiError(`Backend returned non-JSON (HTTP ${status}): ${snippet}`, status);
  }
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; text: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * POST application/x-www-form-urlencoded to the PHP backend, authenticating as
 * the user via `Authorization: Bearer <apiKey>` (the server-to-server path that
 * resolves the uid from sha256(key) and skips the web client-IP check).
 */
/** A form/query value: a scalar, omitted (undefined), or an array sent as repeated `key[]`. */
export type FieldValue = string | number | undefined | ReadonlyArray<string | number>;

export async function postForm(
  config: BackendConfig,
  path: string,
  fields: Record<string, FieldValue>,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const v of value) {
        body.append(`${key}[]`, String(v));
      }
    } else {
      body.append(key, String(value as string | number));
    }
  }
  const { status, text } = await fetchWithTimeout(
    joinUrl(config.baseUrl, path),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    },
    config.timeoutMs,
  );
  if (status < 200 || status >= 300) {
    throw new BackendApiError(`Backend POST ${path} failed with HTTP ${status}`, status);
  }
  return parseJsonOrThrow(text, status) as Record<string, unknown>;
}

/** GET JSON from the PHP backend, authenticating via `Authorization: Bearer <apiKey>`. */
export async function getJson(
  config: BackendConfig,
  path: string,
  params: Record<string, FieldValue>,
  apiKey: string,
): Promise<Record<string, unknown>> {
  const url = new URL(joinUrl(config.baseUrl, path));
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const v of value) {
        url.searchParams.append(`${key}[]`, String(v));
      }
    } else {
      url.searchParams.set(key, String(value as string | number));
    }
  }
  const { status, text } = await fetchWithTimeout(
    url.toString(),
    { method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
    config.timeoutMs,
  );
  if (status < 200 || status >= 300) {
    throw new BackendApiError(`Backend GET ${path} failed with HTTP ${status}`, status);
  }
  return parseJsonOrThrow(text, status) as Record<string, unknown>;
}
