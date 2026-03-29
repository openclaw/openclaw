import * as Lark from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { FeishuConfig, FeishuDomain, ResolvedFeishuAccount } from "./types.js";

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
let httpsProxyAgentCtor: typeof HttpsProxyAgent = HttpsProxyAgent;

/** Default reconnect interval for Feishu WebSocket (in ms). */
const DEFAULT_RECONNECT_INTERVAL_MS = 2 * 60 * 1000; // 2 minutes

/** Maximum reconnect backoff for Feishu WebSocket (in ms). */
const MAX_RECONNECT_BACKOFF_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Applies monkey-patches to the Lark WSClient prototype to fix two bugs:
 * 1. PingInterval may be undefined on system_busy responses, causing a crash
 * 2. Reconnect uses a fixed interval instead of exponential backoff
 *
 * This is applied once at module load time so all WSClient instances are fixed.
 */
function applyFeishuSDKReconnectPatch(): void {
  const WSClient = defaultFeishuClientSdk.WSClient;
  if (!WSClient?.prototype) return;

  const proto = WSClient.prototype;

  // --- Fix 1: Guard PingInterval in handleControlData (pong handler) ---
  const origHandleControlData = proto.handleControlData as
    | ((data: { headers: Array<{ key: string; value: string }>; payload?: Uint8Array }) => Promise<void>)
    | undefined;
  if (origHandleControlData) {
    (proto as Record<string, unknown>).handleControlData = async function (
      data: { headers: Array<{ key: string; value: string }>; payload?: Uint8Array },
    ) {
      try {
        return await origHandleControlData.call(this, data);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("PingInterval")) {
          this.logger?.warn?.(
            "[feishu-ws-patch]",
            "swallowed PingInterval error in pong handler (Feishu system_busy?)",
          );
          return; // swallow — Feishu returns no Pong on system_busy
        }
        throw err;
      }
    };
  }

  // --- Fix 2: Exponential backoff on reConnect ---
  const origReConnect = proto.reConnect as ((isStart?: boolean) => Promise<void>) | undefined;
  if (origReConnect) {
    (proto as Record<string, unknown>).reConnect = async function (isStart = false) {
      if (isStart) {
        // Reset backoff counter on a fresh start
        (this as Record<string, unknown>)._feishuReconnectCount = 0;
      }
      if (!isStart) {
        // Exponential backoff: doubles each retry, capped at MAX_RECONNECT_BACKOFF_MS
        // Add ±20% jitter to avoid synchronized retries across multiple clients
        this._feishuReconnectCount = ((this as Record<string, unknown>)._feishuReconnectCount as number) + 1 || 1;
        const count = (this as Record<string, unknown>)._feishuReconnectCount as number;
        const { reconnectInterval = DEFAULT_RECONNECT_INTERVAL_MS } = this.wsConfig?.getWS?.() ?? {};
        const jitter = 1 + (Math.random() - 0.5) * 0.4; // ±20%
        const backoff = Math.min(reconnectInterval * Math.pow(2, count - 1) * jitter, MAX_RECONNECT_BACKOFF_MS);
        this.logger?.info?.(
          "[feishu-ws-patch]",
          `reconnect backoff: ${Math.round(backoff / 1000)}s (attempt ${count}, jitter ${Math.round((jitter - 1) * 100)}%)`,
        );
        await new Promise<void>((resolve) => setTimeout(resolve, backoff));
      }
      return origReConnect.call(this, isStart);
    };
  }
}

// Apply patch once at module load
applyFeishuSDKReconnectPatch();

/** Default HTTP timeout for Feishu API requests (30 seconds). */
export const FEISHU_HTTP_TIMEOUT_MS = 30_000;
export const FEISHU_HTTP_TIMEOUT_MAX_MS = 300_000;
export const FEISHU_HTTP_TIMEOUT_ENV_VAR = "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS";

type FeishuHttpInstanceLike = Pick<
  typeof feishuClientSdk.defaultHttpInstance,
  "request" | "get" | "post" | "put" | "patch" | "delete" | "head" | "options"
>;

function getWsProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;
  if (!proxyUrl) return undefined;
  return new httpsProxyAgentCtor(proxyUrl);
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
 * but injects a default request timeout to prevent indefinite hangs
 * (e.g. when the Feishu API is slow, causing per-chat queue deadlocks).
 */
function createTimeoutHttpInstance(defaultTimeoutMs: number): Lark.HttpInstance {
  const base: FeishuHttpInstanceLike = feishuClientSdk.defaultHttpInstance;

  function injectTimeout<D>(opts?: Lark.HttpRequestOptions<D>): Lark.HttpRequestOptions<D> {
    return { timeout: defaultTimeoutMs, ...opts } as Lark.HttpRequestOptions<D>;
  }

  return {
    request: (opts) => base.request(injectTimeout(opts)),
    get: (url, opts) => base.get(url, injectTimeout(opts)),
    post: (url, data, opts) => base.post(url, data, injectTimeout(opts)),
    put: (url, data, opts) => base.put(url, data, injectTimeout(opts)),
    patch: (url, data, opts) => base.patch(url, data, injectTimeout(opts)),
    delete: (url, opts) => base.delete(url, injectTimeout(opts)),
    head: (url, opts) => base.head(url, injectTimeout(opts)),
    options: (url, opts) => base.options(url, injectTimeout(opts)),
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
export function createFeishuWSClient(account: ResolvedFeishuAccount): Lark.WSClient {
  const { accountId, appId, appSecret, domain } = account;

  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }

  const agent = getWsProxyAgent();
  return new feishuClientSdk.WSClient({
    appId,
    appSecret,
    domain: resolveDomain(domain),
    loggerLevel: feishuClientSdk.LoggerLevel.info,
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
  HttpsProxyAgent?: typeof HttpsProxyAgent;
}): void {
  feishuClientSdk = overrides?.sdk
    ? { ...defaultFeishuClientSdk, ...overrides.sdk }
    : defaultFeishuClientSdk;
  httpsProxyAgentCtor = overrides?.HttpsProxyAgent ?? HttpsProxyAgent;
}
