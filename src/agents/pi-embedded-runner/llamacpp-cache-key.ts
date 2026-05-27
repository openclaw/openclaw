import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";

const LLAMA_CPP_CACHE_KEY_PROVIDERS = new Set(["llama-cpp-turboquant"]);

export function resolveLlamaCppCacheKey(params: {
  provider: string;
  sessionKey?: string;
  sessionId: string;
}): string | undefined {
  if (!LLAMA_CPP_CACHE_KEY_PROVIDERS.has(params.provider)) {
    return undefined;
  }

  const source = params.sessionKey?.trim() || params.sessionId.trim();
  return source ? `openclaw:${source}` : undefined;
}

export function createLlamaCppCacheKeyWrapper(params: {
  baseStreamFn: StreamFn | undefined;
  provider: string;
  sessionKey?: string;
  sessionId: string;
}): StreamFn | undefined {
  const cacheKey = resolveLlamaCppCacheKey(params);
  if (!cacheKey) {
    return undefined;
  }

  const underlying = params.baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    const originalOnPayload = options?.onPayload;
    return underlying(model, context, {
      ...options,
      onPayload: (payload) => {
        if (payload && typeof payload === "object") {
          const body = payload as Record<string, unknown>;
          body.cache_key ??= cacheKey;
          body.session_id ??= cacheKey;
        }
        originalOnPayload?.(payload);
      },
    });
  };
}
