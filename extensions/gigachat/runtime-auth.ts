import { randomUUID } from "node:crypto";
import type { ProviderPrepareRuntimeAuthContext } from "openclaw/plugin-sdk/core";
import {
  assertOkOrThrowHttpError,
  fetchWithTimeoutGuarded,
  readProviderJsonObjectResponse,
  resolveProviderHttpRequestConfig,
  sanitizeConfiguredModelProviderRequest,
  type ProviderRequestTransportOverrides,
} from "openclaw/plugin-sdk/provider-http";
import {
  GIGACHAT_OAUTH_BASE_URL,
  GIGACHAT_PROVIDER_ID,
  resolveGigachatPluginConfig,
} from "./config.js";

const DEFAULT_TOKEN_TTL_MS = 30 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 2 * 60 * 1000;
const DEFAULT_OAUTH_TIMEOUT_MS = 60_000;
const PROTECTED_OAUTH_HEADERS = new Set(["accept", "authorization", "content-type", "rquid"]);

type TokenCacheEntry = {
  token: string;
  expiresAt: number;
};

type TokenExchangeOptions = {
  fetchFn?: typeof fetch;
  now?: () => number;
  requestId?: () => string;
};

type SanitizedProviderRequest = ReturnType<typeof sanitizeConfiguredModelProviderRequest>;

const tokenCache = new Map<string, TokenCacheEntry>();
const refreshPromises = new Map<string, Promise<TokenCacheEntry>>();

export function resetGigachatRuntimeAuthCacheForTest(): void {
  tokenCache.clear();
  refreshPromises.clear();
}

export function normalizeGigachatAuthorizationHeader(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error("GigaChat Authorization key is empty.");
  }
  const withoutPrefix = trimmed.replace(/^Basic\s+/i, "").trim();
  if (!withoutPrefix) {
    throw new Error("GigaChat Authorization key is empty.");
  }
  return `Basic ${withoutPrefix}`;
}

function normalizeExpiresAt(value: unknown, now: number): number {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    const milliseconds = value < 10_000_000_000 ? value * 1000 : value;
    return milliseconds > now ? milliseconds : now + DEFAULT_TOKEN_TTL_MS;
  }
  return now + DEFAULT_TOKEN_TTL_MS;
}

function sanitizeOauthRequestOverride(
  request: SanitizedProviderRequest,
): ProviderRequestTransportOverrides | undefined {
  if (!request) {
    return undefined;
  }
  const headers = request.headers
    ? Object.fromEntries(
        Object.entries(request.headers).filter(
          ([name]) => !PROTECTED_OAUTH_HEADERS.has(name.trim().toLowerCase()),
        ),
      )
    : undefined;
  const next: ProviderRequestTransportOverrides = {
    ...(headers && Object.keys(headers).length > 0 ? { headers } : {}),
    ...(request.proxy ? { proxy: request.proxy } : {}),
    ...(request.tls ? { tls: request.tls } : {}),
  };
  return Object.keys(next).length > 0 ? next : undefined;
}

function resolveConfiguredProviderRequest(ctx: ProviderPrepareRuntimeAuthContext): {
  request?: ProviderRequestTransportOverrides;
  allowPrivateNetwork?: boolean;
} {
  const providerConfig = ctx.config?.models?.providers?.[GIGACHAT_PROVIDER_ID];
  const configuredRequest = sanitizeConfiguredModelProviderRequest(providerConfig?.request);
  return {
    request: sanitizeOauthRequestOverride(configuredRequest),
    ...(configuredRequest?.allowPrivateNetwork !== undefined
      ? { allowPrivateNetwork: configuredRequest.allowPrivateNetwork }
      : {}),
  };
}

async function exchangeGigachatToken(
  ctx: ProviderPrepareRuntimeAuthContext,
  authorizationHeader: string,
  options: TokenExchangeOptions = {},
): Promise<TokenCacheEntry> {
  const now = options.now?.() ?? Date.now();
  const pluginConfig = resolveGigachatPluginConfig(ctx.config);
  const configuredRequest = resolveConfiguredProviderRequest(ctx);
  const rqUid = options.requestId?.() ?? randomUUID();
  const { baseUrl, headers, dispatcherPolicy, allowPrivateNetwork } =
    resolveProviderHttpRequestConfig({
      baseUrl: GIGACHAT_OAUTH_BASE_URL,
      defaultBaseUrl: GIGACHAT_OAUTH_BASE_URL,
      request: configuredRequest.request,
      allowPrivateNetwork: configuredRequest.allowPrivateNetwork,
      defaultHeaders: {
        Accept: "application/json",
        Authorization: authorizationHeader,
        "Content-Type": "application/x-www-form-urlencoded",
        RqUID: rqUid,
      },
      provider: GIGACHAT_PROVIDER_ID,
      capability: "llm",
      transport: "http",
    });
  const body = new URLSearchParams({ scope: pluginConfig.scope });
  const { response, release } = await fetchWithTimeoutGuarded(
    `${baseUrl}/oauth`,
    {
      method: "POST",
      headers,
      body,
    },
    ctx.model.requestTimeoutMs ?? DEFAULT_OAUTH_TIMEOUT_MS,
    options.fetchFn ?? fetch,
    {
      ...(allowPrivateNetwork ? { ssrfPolicy: { allowPrivateNetwork: true } } : {}),
      dispatcherPolicy,
      auditContext: "gigachat-oauth",
    },
  );
  try {
    await assertOkOrThrowHttpError(response, "GigaChat OAuth token request failed");
    const payload = await readProviderJsonObjectResponse(
      response,
      "GigaChat OAuth token request failed",
    );
    const token = typeof payload.access_token === "string" ? payload.access_token.trim() : "";
    if (!token) {
      throw new Error("GigaChat OAuth token response is missing access_token.");
    }
    return {
      token,
      expiresAt: normalizeExpiresAt(payload.expires_at, now),
    };
  } finally {
    await release();
  }
}

export async function prepareGigachatRuntimeAuth(
  ctx: ProviderPrepareRuntimeAuthContext,
  options: TokenExchangeOptions = {},
) {
  const now = options.now?.() ?? Date.now();
  const authorizationHeader = normalizeGigachatAuthorizationHeader(ctx.apiKey);
  const pluginConfig = resolveGigachatPluginConfig(ctx.config);
  const cacheKey = JSON.stringify([authorizationHeader, pluginConfig.scope]);
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expiresAt > now + TOKEN_REFRESH_MARGIN_MS) {
    return {
      apiKey: cached.token,
      expiresAt: cached.expiresAt,
    };
  }
  let refreshPromise = refreshPromises.get(cacheKey);
  if (!refreshPromise) {
    refreshPromise = exchangeGigachatToken(ctx, authorizationHeader, options).finally(() => {
      refreshPromises.delete(cacheKey);
    });
    refreshPromises.set(cacheKey, refreshPromise);
  }
  const refreshed = await refreshPromise;
  tokenCache.set(cacheKey, refreshed);
  return {
    apiKey: refreshed.token,
    expiresAt: refreshed.expiresAt,
  };
}
