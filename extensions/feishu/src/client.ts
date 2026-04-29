import type { Agent } from "node:https";
import { createRequire } from "node:module";
import * as Lark from "@larksuiteoapi/node-sdk";
import {
  readPluginPackageVersion,
  resolveAmbientNodeProxyAgent,
} from "openclaw/plugin-sdk/extension-shared";
import type { FeishuConfig, FeishuDomain, ResolvedFeishuAccount } from "./types.js";

const require = createRequire(import.meta.url);
const pluginVersion = readPluginPackageVersion({ require });

export { pluginVersion };

const FEISHU_USER_AGENT = `openclaw-feishu-builtin/${pluginVersion}/${process.platform}`;
export { FEISHU_USER_AGENT };

const FEISHU_WS_CLIENT_CONFIG_DEFAULTS = {
  PingInterval: 30,
  ReconnectCount: -1,
  ReconnectInterval: 120,
  ReconnectNonce: 30,
} as const;

/** User-Agent header value for all Feishu API requests. */
export function getFeishuUserAgent(): string {
  return FEISHU_USER_AGENT;
}

type FeishuClientSdk = Pick<
  typeof Lark,
  | "AppType"
  | "Client"
  | "defaultHttpInstance"
  | "Domain"
  | "EventDispatcher"
  | "LoggerLevel"
  | "WSClient"
>;

const defaultFeishuClientSdk: FeishuClientSdk = {
  AppType: Lark.AppType,
  Client: Lark.Client,
  defaultHttpInstance: Lark.defaultHttpInstance,
  Domain: Lark.Domain,
  EventDispatcher: Lark.EventDispatcher,
  LoggerLevel: Lark.LoggerLevel,
  WSClient: Lark.WSClient,
};

let feishuClientSdk: FeishuClientSdk = defaultFeishuClientSdk;

// Override the SDK's default User-Agent interceptor.
// The Lark SDK registers an axios request interceptor that sets
// 'oapi-node-sdk/1.0.0'. Axios request interceptors execute in LIFO order
// (last-registered runs first), so simply appending ours doesn't work — the
// SDK's interceptor would run last and overwrite our UA. We must clear
// handlers[] first, then register our own as the sole interceptor.
//
// Risk is low: the SDK only registers one interceptor (UA) at init time, and
// we clear it at module load before any other code can register handlers.
// If a future SDK version adds more interceptors, the upgrade will need
// compatibility verification regardless.
{
  const inst = Lark.defaultHttpInstance as {
    interceptors?: {
      request: { handlers: unknown[]; use: (fn: (req: unknown) => unknown) => void };
    };
  };
  if (inst.interceptors?.request) {
    inst.interceptors.request.handlers = [];
    inst.interceptors.request.use((req: unknown) => {
      const r = req as { headers?: Record<string, string> };
      if (r.headers) {
        r.headers["User-Agent"] = getFeishuUserAgent();
      }
      return req;
    });
  }
}

/** Default HTTP timeout for Feishu API requests (30 seconds). */
export const FEISHU_HTTP_TIMEOUT_MS = 30_000;
export const FEISHU_HTTP_TIMEOUT_MAX_MS = 300_000;
export const FEISHU_HTTP_TIMEOUT_ENV_VAR = "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS";

type FeishuHttpInstanceLike = Pick<
  typeof feishuClientSdk.defaultHttpInstance,
  "request" | "get" | "post" | "put" | "patch" | "delete" | "head" | "options"
>;

export type FeishuWsLifecycleHooks = {
  onReady?: () => void;
  onError?: (err: Error) => void;
  onReconnecting?: () => void;
  onReconnected?: () => void;
};

type FeishuHttpResponseTransform = <R>(response: R) => R;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function coercePositiveNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function coerceNonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

function coerceReconnectCount(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return fallback;
  }
  const normalized = Math.floor(value);
  return normalized >= -1 ? normalized : fallback;
}

function sanitizeFeishuWsEndpointResponse<R>(response: R): R {
  if (!isRecord(response) || !isRecord(response.data)) {
    return response;
  }
  const clientConfig = response.data.ClientConfig;
  if (!isRecord(clientConfig)) {
    return response;
  }

  return {
    ...response,
    data: {
      ...response.data,
      ClientConfig: {
        ...clientConfig,
        PingInterval: coercePositiveNumber(
          clientConfig.PingInterval,
          FEISHU_WS_CLIENT_CONFIG_DEFAULTS.PingInterval,
        ),
        ReconnectCount: coerceReconnectCount(
          clientConfig.ReconnectCount,
          FEISHU_WS_CLIENT_CONFIG_DEFAULTS.ReconnectCount,
        ),
        ReconnectInterval: coercePositiveNumber(
          clientConfig.ReconnectInterval,
          FEISHU_WS_CLIENT_CONFIG_DEFAULTS.ReconnectInterval,
        ),
        ReconnectNonce: coerceNonNegativeNumber(
          clientConfig.ReconnectNonce,
          FEISHU_WS_CLIENT_CONFIG_DEFAULTS.ReconnectNonce,
        ),
      },
    },
  } as R;
}

async function getWsProxyAgent() {
  return resolveAmbientNodeProxyAgent<Agent>();
}

// Multi-account client cache
const clientCache = new Map<
  string,
  {
    client: Lark.Client;
    config: { appId: string; appSecret: string; domain?: FeishuDomain; httpTimeoutMs: number };
  }
>();

function resolveDomain(domain: FeishuDomain | undefined): Lark.Domain | string {
  if (domain === "lark") {
    return feishuClientSdk.Domain.Lark;
  }
  if (domain === "feishu" || !domain) {
    return feishuClientSdk.Domain.Feishu;
  }
  return domain.replace(/\/+$/, ""); // Custom URL for private deployment
}

/**
 * Create an HTTP instance that delegates to the Lark SDK's default instance
 * but injects a default request timeout and User-Agent header to prevent
 * indefinite hangs and set a standardized User-Agent per OAPI best practices.
 */
function createTimeoutHttpInstance(
  defaultTimeoutMs: number,
  transformResponse?: FeishuHttpResponseTransform,
): Lark.HttpInstance {
  const base: FeishuHttpInstanceLike = feishuClientSdk.defaultHttpInstance;

  function injectTimeout<D>(opts?: Lark.HttpRequestOptions<D>): Lark.HttpRequestOptions<D> {
    return { timeout: defaultTimeoutMs, ...opts } as Lark.HttpRequestOptions<D>;
  }

  async function transform<R>(promise: Promise<R>): Promise<R> {
    const response = await promise;
    return transformResponse ? transformResponse(response) : response;
  }

  return {
    request: (opts) => transform(base.request(injectTimeout(opts))),
    get: (url, opts) => transform(base.get(url, injectTimeout(opts))),
    post: (url, data, opts) => transform(base.post(url, data, injectTimeout(opts))),
    put: (url, data, opts) => transform(base.put(url, data, injectTimeout(opts))),
    patch: (url, data, opts) => transform(base.patch(url, data, injectTimeout(opts))),
    delete: (url, opts) => transform(base.delete(url, injectTimeout(opts))),
    head: (url, opts) => transform(base.head(url, injectTimeout(opts))),
    options: (url, opts) => transform(base.options(url, injectTimeout(opts))),
  };
}

/**
 * Credentials needed to create a Feishu client.
 * Both FeishuConfig and ResolvedFeishuAccount satisfy this interface.
 */
export type FeishuClientCredentials = {
  accountId?: string;
  appId?: string;
  appSecret?: string;
  domain?: FeishuDomain;
  httpTimeoutMs?: number;
  config?: Pick<FeishuConfig, "httpTimeoutMs">;
};

function resolveConfiguredHttpTimeoutMs(creds: FeishuClientCredentials): number {
  const clampTimeout = (value: number): number => {
    const rounded = Math.floor(value);
    return Math.min(Math.max(rounded, 1), FEISHU_HTTP_TIMEOUT_MAX_MS);
  };

  const fromDirectField = creds.httpTimeoutMs;
  if (
    typeof fromDirectField === "number" &&
    Number.isFinite(fromDirectField) &&
    fromDirectField > 0
  ) {
    return clampTimeout(fromDirectField);
  }

  const envRaw = process.env[FEISHU_HTTP_TIMEOUT_ENV_VAR];
  if (envRaw) {
    const envValue = Number(envRaw);
    if (Number.isFinite(envValue) && envValue > 0) {
      return clampTimeout(envValue);
    }
  }

  const fromConfig = creds.config?.httpTimeoutMs;
  const timeout = fromConfig;
  if (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0) {
    return FEISHU_HTTP_TIMEOUT_MS;
  }
  return clampTimeout(timeout);
}

/**
 * Create or get a cached Feishu client for an account.
 * Accepts any object with appId, appSecret, and optional domain/accountId.
 */
export function createFeishuClient(creds: FeishuClientCredentials): Lark.Client {
  const { accountId = "default", appId, appSecret, domain } = creds;
  const defaultHttpTimeoutMs = resolveConfiguredHttpTimeoutMs(creds);

  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }

  // Check cache
  const cached = clientCache.get(accountId);
  if (
    cached &&
    cached.config.appId === appId &&
    cached.config.appSecret === appSecret &&
    cached.config.domain === domain &&
    cached.config.httpTimeoutMs === defaultHttpTimeoutMs
  ) {
    return cached.client;
  }

  // Create new client with timeout-aware HTTP instance
  const client = new feishuClientSdk.Client({
    appId,
    appSecret,
    appType: feishuClientSdk.AppType.SelfBuild,
    domain: resolveDomain(domain),
    httpInstance: createTimeoutHttpInstance(defaultHttpTimeoutMs),
  });

  // Cache it
  clientCache.set(accountId, {
    client,
    config: { appId, appSecret, domain, httpTimeoutMs: defaultHttpTimeoutMs },
  });

  return client;
}

/**
 * Create a Feishu WebSocket client for an account.
 * Note: WSClient is not cached since each call creates a new connection.
 */
export async function createFeishuWSClient(
  account: ResolvedFeishuAccount,
  lifecycleHooks: FeishuWsLifecycleHooks = {},
): Promise<Lark.WSClient> {
  const { accountId, appId, appSecret, domain } = account;
  const defaultHttpTimeoutMs = resolveConfiguredHttpTimeoutMs(account);

  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }

  const agent = await getWsProxyAgent();
  return new feishuClientSdk.WSClient({
    appId,
    appSecret,
    domain: resolveDomain(domain),
    loggerLevel: feishuClientSdk.LoggerLevel.info,
    httpInstance: createTimeoutHttpInstance(defaultHttpTimeoutMs, sanitizeFeishuWsEndpointResponse),
    autoReconnect: true,
    onReady: lifecycleHooks.onReady,
    onError: lifecycleHooks.onError,
    onReconnecting: lifecycleHooks.onReconnecting,
    onReconnected: lifecycleHooks.onReconnected,
    ...(agent ? { agent } : {}),
  });
}

/**
 * Create an event dispatcher for an account.
 */
export function createEventDispatcher(account: ResolvedFeishuAccount): Lark.EventDispatcher {
  return new feishuClientSdk.EventDispatcher({
    encryptKey: account.encryptKey,
    verificationToken: account.verificationToken,
  });
}

/**
 * Get a cached client for an account (if exists).
 */
export function getFeishuClient(accountId: string): Lark.Client | null {
  return clientCache.get(accountId)?.client ?? null;
}

/**
 * Clear client cache for a specific account or all accounts.
 */
export function clearClientCache(accountId?: string): void {
  if (accountId) {
    clientCache.delete(accountId);
  } else {
    clientCache.clear();
  }
}

export function setFeishuClientRuntimeForTest(overrides?: {
  sdk?: Partial<FeishuClientSdk>;
}): void {
  feishuClientSdk = overrides?.sdk
    ? { ...defaultFeishuClientSdk, ...overrides.sdk }
    : defaultFeishuClientSdk;
}
