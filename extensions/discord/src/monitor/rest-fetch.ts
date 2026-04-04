import { wrapFetchWithAbortSignal } from "openclaw/plugin-sdk/fetch-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { ProxyAgent, fetch as undiciFetch } from "undici";
import { withValidatedDiscordProxy } from "../proxy-fetch.js";

export function resolveDiscordRestFetch(
  proxyUrl: string | undefined,
  runtime: RuntimeEnv,
): typeof fetch {
  const fetcher = withValidatedDiscordProxy(proxyUrl, runtime, (proxy) => {
    const agent = new ProxyAgent(proxy);
    return wrapFetchWithAbortSignal(
      ((input: RequestInfo | URL, init?: RequestInit) =>
        undiciFetch(input as string | URL, {
          ...(init as Record<string, unknown>),
          dispatcher: agent,
        }) as unknown as Promise<Response>) as typeof fetch,
    );
  });
  if (!fetcher) {
    return fetch;
  }
  runtime.log?.("discord: rest proxy enabled");
  return fetcher;
}
