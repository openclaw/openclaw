import { randomUUID } from "node:crypto";
import { wrapFetchWithAbortSignal } from "openclaw/plugin-sdk/fetch-runtime";
import {
  captureHttpExchange,
  resolveEffectiveDebugProxyUrl,
} from "openclaw/plugin-sdk/proxy-capture";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { resolveDiscordProxyFetchByUrl } from "../proxy-fetch.js";

export function resolveDiscordRestFetch(
  proxyUrl: string | undefined,
  runtime: RuntimeEnv,
): typeof fetch {
  const effectiveProxyUrl = resolveEffectiveDebugProxyUrl(proxyUrl);
  const discordFetch = resolveDiscordProxyFetchByUrl(effectiveProxyUrl, runtime);
  const fetcher = discordFetch
    ? wrapFetchWithAbortSignal(((input: RequestInfo | URL, init?: RequestInit) =>
        discordFetch(input, init).then((response) => {
          captureHttpExchange({
            url: resolveRequestUrl(input),
            method: init?.method ?? "GET",
            requestHeaders: init?.headers as Headers | Record<string, string> | undefined,
            requestBody: (init as RequestInit & { body?: BodyInit | null })?.body ?? null,
            response,
            flowId: randomUUID(),
            meta: { subsystem: "discord-rest" },
          });
          return response;
        })) as typeof fetch)
    : undefined;
  if (!fetcher) {
    return fetch;
  }
  runtime.log?.("discord: rest proxy enabled");
  return fetcher;
}
