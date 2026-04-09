import type { Dispatcher } from "undici";
import { ProxyAgent, fetch as undiciFetch } from "undici";

import { toStr } from "./shared/to-str.js";
type ProxyDispatcher = Dispatcher;

const proxyDispatchers = new Map<string, ProxyDispatcher>();

/**
 * **getProxyDispatcher (get proxy Dispatcher)**
 *
 * Caches and reuses ProxyAgent instances to avoid creating duplicate connection pools.
 */
function getProxyDispatcher(proxyUrl: string): ProxyDispatcher {
  const existing = proxyDispatchers.get(proxyUrl);
  if (existing) {
    return existing;
  }
  const created = new ProxyAgent(proxyUrl);
  proxyDispatchers.set(proxyUrl, created);
  return created;
}

function mergeAbortSignal(params: {
  signal?: AbortSignal;
  timeoutMs?: number;
}): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (params.signal) {
    signals.push(params.signal);
  }
  if (params.timeoutMs && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
    signals.push(AbortSignal.timeout(params.timeoutMs));
  }
  if (!signals.length) {
    return undefined;
  }
  if (signals.length === 1) {
    return signals[0];
  }
  return AbortSignal.any(signals);
}

/**
 * **WecomHttpOptions (HTTP options)**
 *
 * @property proxyUrl Proxy server address
 * @property timeoutMs Request timeout (ms)
 * @property signal AbortSignal
 */
export type WecomHttpOptions = {
  proxyUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * **wecomFetch (unified HTTP request)**
 *
 * A fetch wrapper based on `undici` that automatically handles ProxyAgent and Timeout.
 * All calls to the WeCom API should go through this function.
 */
export async function wecomFetch(
  input: string | URL,
  init?: RequestInit,
  opts?: WecomHttpOptions,
): Promise<Response> {
  const proxyUrl = opts?.proxyUrl?.trim() ?? "";
  const dispatcher = proxyUrl ? getProxyDispatcher(proxyUrl) : undefined;

  const initSignal = init?.signal ?? undefined;
  const signal = mergeAbortSignal({
    signal: opts?.signal ?? initSignal,
    timeoutMs: opts?.timeoutMs,
  });

  const headers = new Headers(init?.headers ?? {});
  if (!headers.has("User-Agent")) {
    headers.set("User-Agent", "OpenClaw/2.0 (WeCom-Agent)");
  }

  const nextInit: unknown = {
    ...init,
    ...(signal ? { signal } : {}),
    ...(dispatcher ? { dispatcher } : {}),
    headers,
  };

  try {
    return (await undiciFetch(
      input,
      nextInit as Parameters<typeof undiciFetch>[1],
    )) as unknown as Response;
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "TypeError" && err.message === "fetch failed") {
      const cause = (err as { cause?: unknown }).cause;
      const causeStr = cause instanceof Error ? cause.message : toStr(cause);
      console.error(
        `[wecom-http] fetch failed: ${input} (proxy: ${proxyUrl || "none"})${causeStr ? ` - cause: ${causeStr}` : ""}`,
      );
    }
    throw err;
  }
}

/**
 * **readResponseBodyAsBuffer (read response body)**
 *
 * Reads the Response body as a Buffer, with an optional max byte limit to prevent memory overflow.
 * Suitable for scenarios like downloading media files.
 */
export async function readResponseBodyAsBuffer(res: Response, maxBytes?: number): Promise<Buffer> {
  if (!res.body) {
    return Buffer.alloc(0);
  }

  const limit = maxBytes && Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }

    total += value.byteLength;
    if (limit && total > limit) {
      try {
        await reader.cancel("body too large");
      } catch {
        // ignore
      }
      throw new Error(`response body too large (>${limit} bytes)`);
    }
    chunks.push(value);
  }

  return Buffer.concat(chunks.map((c) => Buffer.from(c)));
}
