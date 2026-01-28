import { ProxyAgent } from "undici";

import type { KakaoFetch } from "./api.js";

export function resolveKakaoProxyFetch(proxyUrl?: string): KakaoFetch | undefined {
  if (!proxyUrl?.trim()) return undefined;

  const agent = new ProxyAgent(proxyUrl);

  return async (input: string, init?: RequestInit): Promise<Response> => {
    const { default: nodeFetch } = await import("node-fetch");
    // @ts-expect-error node-fetch dispatcher option
    return nodeFetch(input, { ...init, dispatcher: agent }) as unknown as Response;
  };
}
