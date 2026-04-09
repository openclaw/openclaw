import { ProxyAgent, fetch as undiciFetch } from "undici";

import { toStr } from "../shared/to-str.js";
const proxyDispatchers = new Map<string, ProxyAgent>();

/**
 * **getProxyDispatcher (get proxy Dispatcher)**
 *
 * Caches and reuses ProxyAgent to avoid recreating connection pools.
 */
function getProxyDispatcher(proxyUrl: string): ProxyAgent {
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
 * @property timeoutMs Request timeout (milliseconds)
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
 * Fetch wrapper based on `undici` that automatically handles ProxyAgent and Timeout.
 * All calls to WeCom APIs should go through this function.
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

  const nextInit: Record<string, unknown> = {
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
      const cause = (err as unknown as Record<string, unknown>).cause;
      console.error(
        `[wecom-http] fetch failed: ${input} (proxy: ${proxyUrl || "none"})${cause ? ` - cause: ${toStr(cause)}` : ""}`,
      );
    }
    throw err;
  }
}

/**
 * **readResponseBodyAsBuffer (read response body)**
 *
 * Reads Response Body as Buffer with max byte limit to prevent memory overflow.
 * Suitable for media file downloads and similar scenarios.
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
