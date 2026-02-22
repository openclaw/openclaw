import type { Dispatcher } from "undici";
import { ProxyAgent, fetch as undiciFetch } from "undici";

type ProxyDispatcher = Dispatcher;

const proxyDispatchers = new Map<string, ProxyDispatcher>();

/**
 * **getProxyDispatcher (获取代理 Dispatcher)**
 *
 * 缓存并复用 ProxyAgent，避免重复创建连接池。
 */
function getProxyDispatcher(proxyUrl: string): ProxyDispatcher {
  const existing = proxyDispatchers.get(proxyUrl);
  if (existing) return existing;
  const created = new ProxyAgent(proxyUrl);
  proxyDispatchers.set(proxyUrl, created);
  return created;
}

function mergeAbortSignal(params: {
  signal?: AbortSignal;
  timeoutMs?: number;
}): AbortSignal | undefined {
  const signals: AbortSignal[] = [];
  if (params.signal) signals.push(params.signal);
  if (params.timeoutMs && Number.isFinite(params.timeoutMs) && params.timeoutMs > 0) {
    signals.push(AbortSignal.timeout(params.timeoutMs));
  }
  if (!signals.length) return undefined;
  if (signals.length === 1) return signals[0];
  return AbortSignal.any(signals);
}

/**
 * **WecomHttpOptions (HTTP 选项)**
 *
 * @property proxyUrl 代理服务器地址
 * @property timeoutMs 请求超时时间 (毫秒)
 * @property signal AbortSignal 信号
 */
export type WecomHttpOptions = {
  proxyUrl?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
};

/**
 * **wecomFetch (统一 HTTP 请求)**
 *
 * 基于 `undici` 的 fetch 封装，自动处理 ProxyAgent 和 Timeout。
 * 所有对企业微信 API 的调用都应经过此函数。
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
  const nextInit: RequestInit & { dispatcher?: Dispatcher } = {
    ...(init ?? {}),
    ...(signal ? { signal } : {}),
    ...(dispatcher ? { dispatcher } : {}),
  };

  return undiciFetch(
    input,
    nextInit as Parameters<typeof undiciFetch>[1],
  ) as unknown as Promise<Response>;
}

/**
 * **readResponseBodyAsBuffer (读取响应 Body)**
 *
 * 将 Response Body 读取为 Buffer，支持最大字节限制以防止内存溢出。
 * 适用于下载媒体文件等场景。
 */
export async function readResponseBodyAsBuffer(res: Response, maxBytes?: number): Promise<Buffer> {
  if (!res.body) return Buffer.alloc(0);

  const limit = maxBytes && Number.isFinite(maxBytes) && maxBytes > 0 ? maxBytes : undefined;
  const chunks: Uint8Array[] = [];
  let total = 0;

  const reader = res.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;

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
