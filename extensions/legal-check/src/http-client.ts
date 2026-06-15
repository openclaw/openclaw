import type { LegalApiConfig } from "./types.js";

const DEFAULT_BASE_URL = "https://v2.businesstimescn.com";
const DEFAULT_TIMEOUT_MS = 30_000;

/** Resolve config from plugin config, falling back to env then defaults. */
export function resolveConfig(pluginConfig: Record<string, unknown>): LegalApiConfig {
  const block = pluginConfig.legalApi as Record<string, unknown> | undefined;
  const baseUrl = ((block?.baseUrl as string) ?? process.env.LEGAL_API_BASE_URL ?? DEFAULT_BASE_URL)
    .trim()
    .replace(/\/+$/, "");
  const timeoutMs = Number(
    block?.timeoutMs ?? process.env.LEGAL_API_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS,
  );
  return {
    baseUrl,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS,
  };
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl}/${path.replace(/^\/+/, "")}`;
}

/** Thrown for non-2xx responses or bodies that are not parseable JSON. */
export class LegalApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "LegalApiError";
    this.status = status;
  }
}

function parseJsonOrThrow(text: string, status: number): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const snippet = text.slice(0, 200).replace(/\s+/g, " ").trim();
    throw new LegalApiError(`Backend returned non-JSON (HTTP ${status}): ${snippet}`, status);
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
 * POST application/x-www-form-urlencoded to the PHP backend as the given user.
 * The backend authenticates the request from the X-Auth-Token header (the uid),
 * exactly as the Nuxt /api/post proxy does for the web UI.
 */
export async function postForm(
  config: LegalApiConfig,
  path: string,
  fields: Record<string, string | number | undefined>,
  userId: string,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) {
      continue;
    }
    body.append(key, String(value));
  }
  const { status, text } = await fetchWithTimeout(
    joinUrl(config.baseUrl, path),
    {
      method: "POST",
      headers: {
        "X-Auth-Token": userId,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body: body.toString(),
    },
    config.timeoutMs,
  );
  if (status < 200 || status >= 300) {
    throw new LegalApiError(`Backend POST ${path} failed with HTTP ${status}`, status);
  }
  return parseJsonOrThrow(text, status) as Record<string, unknown>;
}

/** GET JSON from the PHP backend as the given user (X-Auth-Token = uid). */
export async function getJson(
  config: LegalApiConfig,
  path: string,
  params: Record<string, string | number | undefined>,
  userId: string,
): Promise<Record<string, unknown>> {
  const url = new URL(joinUrl(config.baseUrl, path));
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  const { status, text } = await fetchWithTimeout(
    url.toString(),
    { method: "GET", headers: { "X-Auth-Token": userId, Accept: "application/json" } },
    config.timeoutMs,
  );
  if (status < 200 || status >= 300) {
    throw new LegalApiError(`Backend GET ${path} failed with HTTP ${status}`, status);
  }
  return parseJsonOrThrow(text, status) as Record<string, unknown>;
}
