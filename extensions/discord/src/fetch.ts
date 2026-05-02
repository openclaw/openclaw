import { randomUUID } from "node:crypto";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  getProxyUrlFromFetch,
  hasEnvHttpProxyAgentConfigured,
  resolveEnvHttpProxyAgentOptions,
  resolveFetch,
  type PinnedDispatcherPolicy,
} from "openclaw/plugin-sdk/fetch-runtime";
import {
  captureHttpExchange,
  resolveEffectiveDebugProxyUrl,
} from "openclaw/plugin-sdk/proxy-capture";
import { resolveRequestUrl } from "openclaw/plugin-sdk/request-url";
import { createSubsystemLogger } from "openclaw/plugin-sdk/runtime-env";
import { Agent, EnvHttpProxyAgent, ProxyAgent, fetch as undiciFetch } from "undici";
import { makeProxyFetch } from "./proxy.js";

const log = createSubsystemLogger("discord/network");

const DISCORD_DISPATCHER_KEEP_ALIVE_TIMEOUT_MS = 30_000;
const DISCORD_DISPATCHER_KEEP_ALIVE_MAX_TIMEOUT_MS = 600_000;
const DISCORD_DISPATCHER_CONNECTIONS_PER_ORIGIN = 10;
const DISCORD_DISPATCHER_PIPELINING = 1;

type DiscordAgentPoolOptions = {
  allowH2: false;
  keepAliveTimeout: number;
  keepAliveMaxTimeout: number;
  connections: number;
  pipelining: number;
};

function discordAgentPoolOptions(): DiscordAgentPoolOptions {
  return {
    allowH2: false,
    keepAliveTimeout: DISCORD_DISPATCHER_KEEP_ALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: DISCORD_DISPATCHER_KEEP_ALIVE_MAX_TIMEOUT_MS,
    connections: DISCORD_DISPATCHER_CONNECTIONS_PER_ORIGIN,
    pipelining: DISCORD_DISPATCHER_PIPELINING,
  };
}

type RequestInitWithDispatcher = RequestInit & {
  dispatcher?: unknown;
};

type DiscordDispatcher = Agent | EnvHttpProxyAgent | ProxyAgent;

type DiscordDispatcherMode = "direct" | "env-proxy" | "explicit-proxy";

function hasEnvHttpProxyForDiscordApi(env: NodeJS.ProcessEnv = process.env): boolean {
  return hasEnvHttpProxyAgentConfigured(env);
}

function resolveOpenClawProxyUrlForDiscord(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const proxyUrl = env.OPENCLAW_PROXY_URL?.trim();
  return proxyUrl ? proxyUrl : undefined;
}

function resolveDiscordDispatcherPolicy(params: { useEnvProxy: boolean; proxyUrl?: string }): {
  policy: PinnedDispatcherPolicy;
  mode: DiscordDispatcherMode;
} {
  const explicitProxyUrl = params.proxyUrl?.trim();
  if (explicitProxyUrl) {
    return {
      policy: {
        mode: "explicit-proxy",
        proxyUrl: validateDiscordProxyUrl(explicitProxyUrl),
        allowPrivateProxy: true,
      },
      mode: "explicit-proxy",
    };
  }
  if (params.useEnvProxy) {
    return {
      policy: { mode: "env-proxy" },
      mode: "env-proxy",
    };
  }
  return {
    policy: { mode: "direct" },
    mode: "direct",
  };
}

function createDiscordDispatcher(policy: PinnedDispatcherPolicy): {
  dispatcher: DiscordDispatcher;
  mode: DiscordDispatcherMode;
  effectivePolicy: PinnedDispatcherPolicy;
} {
  const poolOptions = discordAgentPoolOptions();

  if (policy.mode === "explicit-proxy") {
    const proxyOptions = {
      uri: validateDiscordProxyUrl(policy.proxyUrl),
      ...poolOptions,
      ...(policy.proxyTls ? { requestTls: policy.proxyTls } : {}),
    } satisfies ConstructorParameters<typeof ProxyAgent>[0];
    try {
      return {
        dispatcher: new ProxyAgent(proxyOptions),
        mode: "explicit-proxy",
        effectivePolicy: policy,
      };
    } catch (err) {
      const reason = formatErrorMessage(err);
      throw new Error(`explicit proxy dispatcher init failed: ${reason}`, { cause: err });
    }
  }

  if (policy.mode === "env-proxy") {
    const proxyOptions = {
      ...poolOptions,
      ...resolveEnvHttpProxyAgentOptions(),
      ...(policy.connect ? { connect: policy.connect } : {}),
      ...(policy.proxyTls ? { proxyTls: policy.proxyTls } : {}),
    } satisfies ConstructorParameters<typeof EnvHttpProxyAgent>[0];
    try {
      return {
        dispatcher: new EnvHttpProxyAgent(proxyOptions),
        mode: "env-proxy",
        effectivePolicy: policy,
      };
    } catch (err) {
      log.warn(
        `env proxy dispatcher init failed; falling back to direct dispatcher: ${formatErrorMessage(err)}`,
      );
      const directPolicy: PinnedDispatcherPolicy = {
        mode: "direct",
        ...(policy.connect ? { connect: policy.connect } : {}),
      };
      return {
        dispatcher: new Agent({
          ...poolOptions,
          ...(directPolicy.connect ? { connect: directPolicy.connect } : {}),
        } satisfies ConstructorParameters<typeof Agent>[0]),
        mode: "direct",
        effectivePolicy: directPolicy,
      };
    }
  }

  return {
    dispatcher: new Agent({
      ...poolOptions,
      ...(policy.connect ? { connect: policy.connect } : {}),
    } satisfies ConstructorParameters<typeof Agent>[0]),
    mode: "direct",
    effectivePolicy: policy,
  };
}

function withDispatcherIfMissing(
  init: RequestInit | undefined,
  dispatcher: DiscordDispatcher,
): RequestInitWithDispatcher {
  const withDispatcher = init as RequestInitWithDispatcher | undefined;
  if (withDispatcher?.dispatcher) {
    return init ?? {};
  }
  return init ? { ...init, dispatcher } : { dispatcher };
}

function resolveWrappedFetch(fetchImpl: typeof fetch): typeof fetch {
  return resolveFetch(fetchImpl) ?? fetchImpl;
}

async function destroyOwnedDispatcher(dispatcher: DiscordDispatcher | undefined): Promise<void> {
  if (!dispatcher) {
    return;
  }
  try {
    await dispatcher.destroy();
  } catch {
    // Intentionally ignored: dispatcher may already be destroyed.
  }
}

export type DiscordTransport = {
  fetch: typeof fetch;
  sourceFetch: typeof fetch;
  dispatcherPolicy?: PinnedDispatcherPolicy;
  close(): Promise<void>;
};

export function validateDiscordProxyUrl(proxyUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
  } catch {
    throw new Error("Proxy URL must be a valid http or https URL");
  }
  if (!["http:", "https:"].includes(parsed.protocol)) {
    throw new Error("Proxy URL must use http or https");
  }
  return proxyUrl;
}

export function resolveDiscordTransport(proxyFetch?: typeof fetch): DiscordTransport {
  const effectiveProxyFetch =
    proxyFetch ??
    (() => {
      const debugProxyUrl = resolveEffectiveDebugProxyUrl(undefined);
      return debugProxyUrl ? makeProxyFetch(debugProxyUrl) : undefined;
    })();
  const explicitProxyUrl = effectiveProxyFetch
    ? getProxyUrlFromFetch(effectiveProxyFetch)
    : undefined;
  const hasEnvProxy = !explicitProxyUrl && hasEnvHttpProxyForDiscordApi();
  const managedProxyUrl =
    !effectiveProxyFetch && !hasEnvProxy ? resolveOpenClawProxyUrlForDiscord() : undefined;
  const resolvedExplicitProxyUrl = explicitProxyUrl ?? managedProxyUrl;
  const sourceFetch = resolvedExplicitProxyUrl
    ? resolveWrappedFetch(undiciFetch as unknown as typeof fetch)
    : effectiveProxyFetch
      ? resolveWrappedFetch(effectiveProxyFetch)
      : resolveWrappedFetch(undiciFetch as unknown as typeof fetch);

  if (effectiveProxyFetch && !explicitProxyUrl) {
    return { fetch: sourceFetch, sourceFetch, close: async () => {} };
  }

  const dispatcherResolution = resolveDiscordDispatcherPolicy({
    useEnvProxy: !resolvedExplicitProxyUrl && hasEnvProxy,
    proxyUrl: resolvedExplicitProxyUrl,
  });
  const dispatcher = createDiscordDispatcher(dispatcherResolution.policy);

  const resolvedFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await sourceFetch(input, withDispatcherIfMissing(init, dispatcher.dispatcher));
    captureHttpExchange({
      url: resolveRequestUrl(input),
      method: init?.method ?? "GET",
      requestHeaders: init?.headers as Headers | Record<string, string> | undefined,
      requestBody: (init as RequestInit & { body?: BodyInit | null })?.body ?? null,
      response,
      flowId: randomUUID(),
      meta: { subsystem: "discord-fetch" },
    });
    return response;
  }) as typeof fetch;

  let closed = false;
  return {
    fetch: resolvedFetch,
    sourceFetch,
    dispatcherPolicy: dispatcher.effectivePolicy,
    close: async () => {
      if (closed) {
        return;
      }
      closed = true;
      await destroyOwnedDispatcher(dispatcher.dispatcher);
    },
  };
}

export function resolveDiscordFetch(proxyFetch?: typeof fetch): typeof fetch {
  return resolveDiscordTransport(proxyFetch).fetch;
}
