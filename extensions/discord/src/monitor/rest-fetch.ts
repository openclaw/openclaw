import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import * as fetchRuntimeSdk from "openclaw/plugin-sdk/fetch-runtime";
import {
  createHttp1EnvHttpProxyAgent,
  createHttp1ProxyAgent,
  resolveEnvHttpProxyAgentOptions,
  wrapFetchWithAbortSignal,
} from "openclaw/plugin-sdk/fetch-runtime";
import * as proxyCaptureSdk from "openclaw/plugin-sdk/proxy-capture";
import { resolveEffectiveDebugProxyUrl } from "openclaw/plugin-sdk/proxy-capture";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithRuntimeDispatcher } from "openclaw/plugin-sdk/runtime-fetch";
import type { Dispatcher } from "undici";
import { createDiscordDnsLookup } from "../network-config.js";
import { withValidatedDiscordProxy } from "../proxy-fetch.js";

// The shipped 2026.9.6 host omits async capture; retire this check when the minimum advances.
const captureSdk: Partial<Pick<typeof proxyCaptureSdk, "captureHttpExchangeAsync">> =
  proxyCaptureSdk;

// The 2026.9.6 SDK has only the environment-aware factory; retire with that host floor.
const fetchSdk: Partial<Pick<typeof fetchRuntimeSdk, "createHttp1Agent">> = fetchRuntimeSdk;

const discordDnsLookup = createDiscordDnsLookup();

function createEnvProxyDiscordRestDispatcher(
  runtime: RuntimeEnv,
): ReturnType<typeof createHttp1EnvHttpProxyAgent> | undefined {
  const envProxyOptions = resolveEnvHttpProxyAgentOptions();
  if (!envProxyOptions) {
    return undefined;
  }
  try {
    return createHttp1EnvHttpProxyAgent({
      ...envProxyOptions,
      connect: { lookup: discordDnsLookup },
    });
  } catch (err) {
    runtime.error?.(
      danger(
        `discord: env proxy unavailable for REST fetch; using direct dispatcher: ${formatErrorMessage(err)}`,
      ),
    );
    return undefined;
  }
}

function createDiscordRestFetchWithDispatcher(dispatcher: Dispatcher): typeof fetch {
  return wrapFetchWithAbortSignal(((input: RequestInfo | URL, init?: RequestInit) =>
    fetchWithRuntimeDispatcher(input, { ...init, dispatcher }).then((response) => {
      // Finalization retains capture failures; observe the Promise returned by the SDK view.
      void captureSdk
        .captureHttpExchangeAsync?.({
          url: resolveRequestUrl(input),
          method: init?.method ?? "GET",
          requestHeaders: init?.headers as Headers | Record<string, string> | undefined,
          requestBody: (init as RequestInit & { body?: BodyInit | null })?.body ?? null,
          response,
          flowId: randomUUID(),
          meta: { subsystem: "discord-rest" },
        })
        .catch(() => {});
      return response;
    })) as typeof fetch);
}

export function resolveDiscordRestFetch(
  proxyUrl: string | undefined,
  runtime: RuntimeEnv,
): typeof fetch {
  const effectiveProxyUrl = resolveEffectiveDebugProxyUrl(proxyUrl);
  if (effectiveProxyUrl) {
    const fetcher = withValidatedDiscordProxy(effectiveProxyUrl, runtime, (proxy) =>
      createDiscordRestFetchWithDispatcher(createHttp1ProxyAgent({ uri: proxy })),
    );
    if (!fetcher) {
      return fetch;
    }
    runtime.log?.("discord: rest proxy enabled");
    return fetcher;
  }

  return createDiscordRestFetchWithDispatcher(
    createEnvProxyDiscordRestDispatcher(runtime) ??
      fetchSdk.createHttp1Agent?.({ connect: { lookup: discordDnsLookup } }) ??
      createHttp1EnvHttpProxyAgent({
        // Empty overrides keep the direct fallback independent of invalid proxy environment.
        httpProxy: "",
        httpsProxy: "",
        noProxy: "*",
        connect: { lookup: discordDnsLookup },
      }),
  );
}
