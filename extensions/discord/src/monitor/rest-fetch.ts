import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  addActiveManagedProxyTlsOptions,
  resolveEnvHttpProxyAgentOptions,
  wrapFetchWithAbortSignal,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  captureHttpExchange,
  resolveEffectiveDebugProxyUrl,
} from "openclaw/plugin-sdk/proxy-capture";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import { createDiscordDnsLookup } from "../network-config.js";
import { withValidatedDiscordProxy } from "../proxy-fetch.js";

const discordDnsLookup = createDiscordDnsLookup();

type DiscordRestDispatcher =
  | InstanceType<typeof Agent>
  | InstanceType<typeof EnvHttpProxyAgent>
  | InstanceType<typeof ProxyAgent>;

function createDirectDiscordRestDispatcher(): InstanceType<typeof Agent> {
  return new Agent({
    allowH2: false,
    connect: { lookup: discordDnsLookup },
  });
}

function createEnvProxyDiscordRestDispatcher(
  runtime: RuntimeEnv,
): InstanceType<typeof EnvHttpProxyAgent> | undefined {
  const envProxyOptions = resolveEnvHttpProxyAgentOptions();
  if (!envProxyOptions) {
    return undefined;
  }
  try {
    return new EnvHttpProxyAgent(
      addActiveManagedProxyTlsOptions({
        ...envProxyOptions,
        allowH2: false,
        connect: { lookup: discordDnsLookup },
      }) satisfies ConstructorParameters<typeof EnvHttpProxyAgent>[0],
    );
  } catch (err) {
    runtime.error?.(
      danger(
        `discord: env proxy unavailable for REST fetch; using direct dispatcher: ${formatErrorMessage(err)}`,
      ),
    );
    return undefined;
  }
}

function createDiscordRestFetchWithDispatcher(dispatcher: DiscordRestDispatcher): typeof fetch {
  return wrapFetchWithAbortSignal(((input: RequestInfo | URL, init?: RequestInit) =>
    (
      undiciFetch(input as string | URL, {
        ...(init as Record<string, unknown>),
        dispatcher,
      }) as unknown as Promise<Response>
    ).then((response) => {
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
    })) as typeof fetch);
}

export function resolveDiscordRestFetch(
  proxyUrl: string | undefined,
  runtime: RuntimeEnv,
): typeof fetch {
  const effectiveProxyUrl = resolveEffectiveDebugProxyUrl(proxyUrl);
  if (effectiveProxyUrl) {
    const fetcher = withValidatedDiscordProxy(effectiveProxyUrl, runtime, (proxy) =>
      createDiscordRestFetchWithDispatcher(
        new ProxyAgent(
          addActiveManagedProxyTlsOptions({
            uri: proxy,
            allowH2: false,
          }) satisfies ConstructorParameters<typeof ProxyAgent>[0],
        ),
      ),
    );
    if (!fetcher) {
      return fetch;
    }
    runtime.log?.("discord: rest proxy enabled");
    return fetcher;
  }

  const fetcher = createDiscordRestFetchWithDispatcher(
    createEnvProxyDiscordRestDispatcher(runtime) ?? createDirectDiscordRestDispatcher(),
  );
  return fetcher;
}
