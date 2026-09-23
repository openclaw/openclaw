import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { fetchBrowserJson } from "./client-fetch.js";

type BrowserClientRequest = {
  method: "GET" | "POST" | "DELETE";
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  profile?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/** An explicit execution route; node routing and fallback stay with its caller. */
export type BrowserClientTarget =
  | string
  | ((request: BrowserClientRequest) => Promise<unknown>)
  | undefined;

export function browserClientTimeout(
  target: BrowserClientTarget,
  requested: number | undefined,
  localDefault: number,
): number | undefined {
  // An omitted node timeout also belongs to its safe host-fallback contract.
  return typeof target === "function" ? requested : resolveTimerTimeoutMs(requested, localDefault);
}

/** Send the same explicitly projected request through the selected transport. */
export async function requestBrowserJson<T>(
  target: BrowserClientTarget,
  path: string,
  opts: Omit<BrowserClientRequest, "path" | "method"> & {
    method?: BrowserClientRequest["method"];
  } = {},
): Promise<T> {
  if (typeof target === "function") {
    // SAFETY: Node and local transports dispatch the same typed browser-control routes.
    return (await target({ ...opts, method: opts.method ?? "GET", path })) as T;
  }
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(opts.query ?? {})) {
    if (value !== undefined) {
      query.set(key, String(value));
    }
  }
  const suffix = query.size ? `${path.includes("?") ? "&" : "?"}${query}` : "";
  const profile = opts.profile
    ? `${suffix || path.includes("?") ? "&" : "?"}profile=${encodeURIComponent(opts.profile)}`
    : "";
  const baseUrl = target?.trim().replace(/\/$/, "") ?? "";
  return await fetchBrowserJson<T>(`${baseUrl}${path}${suffix}${profile}`, {
    method: opts.method,
    ...(opts.body === undefined
      ? {}
      : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(opts.body) }),
    timeoutMs: opts.timeoutMs,
    signal: opts.signal,
  });
}

export function postBrowserJson<T>(
  target: BrowserClientTarget,
  path: string,
  body: object,
  timeoutMs: number | undefined,
  opts?: { profile?: string; signal?: AbortSignal },
): Promise<T> {
  return requestBrowserJson(target, path, {
    method: "POST",
    body,
    timeoutMs,
    profile: opts?.profile,
    signal: opts?.signal,
  });
}
