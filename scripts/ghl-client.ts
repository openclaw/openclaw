/**
 * Go High Level (GHL) API Client
 *
 * Reusable fetch-based client for the LeadConnector / GHL REST API.
 * Handles auth, location ID injection, versioning, pagination, and rate limiting.
 *
 * Credentials are resolved from env vars or ~/.openclaw/.env:
 *   GHL_API_KEY       — Private Integration Token (pit-…)
 *   GHL_LOCATION_ID   — Location ID passed as query param on every request
 *
 * Usage:
 *   import { ghl, ghlPaginate } from "./ghl-client";
 *   const calendars = await ghl("/calendars/");
 *   const allContacts = await ghlPaginate("/contacts/");
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-04-15";
const REQUEST_DELAY_MS = 50;

function resolveEnvVar(name: string): string {
  if (process.env[name]) {
    return process.env[name];
  }

  for (const envPath of [join(process.cwd(), ".env"), join(homedir(), ".openclaw", ".env")]) {
    try {
      const content = readFileSync(envPath, "utf-8");
      const match = content.match(new RegExp(`^${name}=(.+)$`, "m"));
      if (match?.[1]) {
        return match[1].trim();
      }
    } catch {
      // skip
    }
  }
  throw new Error(`${name} not found in env or .env files`);
}

let _apiKey: string | undefined;
let _locationId: string | undefined;

export function getApiKey(): string {
  if (!_apiKey) {
    _apiKey = resolveEnvVar("GHL_API_KEY");
  }
  return _apiKey;
}

export function getLocationId(): string {
  if (!_locationId) {
    _locationId = resolveEnvVar("GHL_LOCATION_ID");
  }
  return _locationId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface GHLRequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  /** Extra query params merged alongside locationId */
  params?: Record<string, string | number | boolean>;
  /** Override the default API version header */
  version?: string;
  /** Skip automatic locationId injection (rare) */
  skipLocationId?: boolean;
}

/**
 * Single GHL API call. Returns parsed JSON.
 * Automatically injects locationId, Version, and Authorization headers.
 */
export async function ghl<T = unknown>(path: string, opts: GHLRequestOptions = {}): Promise<T> {
  const { method = "GET", body, params = {}, version = API_VERSION, skipLocationId = false } = opts;

  const url = new URL(path.startsWith("http") ? path : `${BASE_URL}${path}`);

  if (!skipLocationId) {
    url.searchParams.set("locationId", getLocationId());
  }
  for (const [k, v] of Object.entries(params)) {
    url.searchParams.set(k, String(v));
  }

  const headers: Record<string, string> = {
    Accept: "application/json",
    Authorization: `Bearer ${getApiKey()}`,
  };
  if (version) {
    headers.Version = version;
  }
  if (body) {
    headers["Content-Type"] = "application/json";
  }

  const res = await fetch(url.toString(), {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "follow",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`GHL API ${res.status} ${method} ${url.pathname}: ${text}`);
  }

  return res.json() as Promise<T>;
}

/**
 * Generic paginator for GHL list endpoints.
 *
 * GHL pagination varies by endpoint but most use either:
 *   - cursor: response has a `meta.nextPageUrl` or `meta.startAfterId`
 *   - offset: `startAfter` / `limit` params
 *
 * This function handles both patterns. Pass `dataKey` to specify which
 * response field holds the array of items (e.g. "contacts", "opportunities").
 */
export async function ghlPaginate<T = unknown>(
  path: string,
  opts: {
    dataKey: string;
    limit?: number;
    params?: Record<string, string | number | boolean>;
    maxPages?: number;
    version?: string;
    skipLocationId?: boolean;
  },
): Promise<T[]> {
  const { dataKey, limit = 100, params = {}, maxPages = 500, version, skipLocationId } = opts;
  const all: T[] = [];
  let cursorId: string | undefined;
  let cursorTs: number | undefined;
  let cursorKey = "startAfterId";
  let page = 0;

  while (page < maxPages) {
    const reqParams: Record<string, string | number | boolean> = {
      ...params,
      limit,
    };
    if (cursorId) {
      reqParams[cursorKey] = cursorId;
    }
    if (cursorTs !== undefined) {
      reqParams.startAfter = cursorTs;
    }

    const res = await ghl<Record<string, unknown>>(path, {
      params: reqParams,
      version,
      skipLocationId,
    });
    const items = (res[dataKey] ?? []) as T[];
    all.push(...items);

    // GHL puts pagination info in `meta` or at the top level depending on endpoint
    const meta = (res.meta ?? {}) as Record<string, unknown>;
    const total = (meta.total ?? res.total) as number | undefined;

    if (page > 0 && page % 10 === 0) {
      const totalStr = total ? ` / ${total}` : "";
      console.log(`    page ${page + 1}: ${all.length} so far${totalStr}`);
    }

    // Stop: reached reported total
    if (total && all.length >= total) {
      break;
    }

    // Stop: fewer items than requested (last page)
    if (items.length < limit) {
      break;
    }

    // Extract next-page cursor — GHL uses different patterns per endpoint:
    //   1. meta.startAfterId + meta.startAfter (contacts, opportunities)
    //   2. meta.nextPageUrl with startAfterId in query string
    //   3. top-level nextCursor (messages-export)
    const nextId = meta.startAfterId as string | undefined;
    const nextTs = meta.startAfter as number | undefined;
    const nextCursor = (meta.nextCursor ?? res.nextCursor) as string | undefined;

    if (nextId) {
      cursorId = nextId;
      if (nextTs) {
        cursorTs = nextTs;
      }
    } else if (nextCursor) {
      cursorId = nextCursor;
      cursorKey = "cursor";
    } else if (meta.nextPageUrl) {
      try {
        const nextUrl = new URL(meta.nextPageUrl as string);
        const urlId = nextUrl.searchParams.get("startAfterId");
        const urlTs = nextUrl.searchParams.get("startAfter");
        if (urlId) {
          cursorId = urlId;
          if (urlTs) {
            cursorTs = Number(urlTs);
          }
        } else {
          break;
        }
      } catch {
        break;
      }
    } else {
      break;
    }

    page++;
    await sleep(REQUEST_DELAY_MS);
  }

  return all;
}
