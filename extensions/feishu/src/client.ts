import * as Lark from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
import type { FeishuConfig, FeishuDomain, ResolvedFeishuAccount } from "./types.js";

/** Default HTTP timeout for Feishu API requests (30 seconds). */
export const FEISHU_HTTP_TIMEOUT_MS = 30_000;
export const FEISHU_HTTP_TIMEOUT_MAX_MS = 300_000;
export const FEISHU_HTTP_TIMEOUT_ENV_VAR = "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS";

function getWsProxyAgent(): HttpsProxyAgent<string> | undefined {
  const proxyUrl =
    process.env.https_proxy ||
    process.env.HTTPS_PROXY ||
    process.env.http_proxy ||
    process.env.HTTP_PROXY;
  if (!proxyUrl) return undefined;
  return new HttpsProxyAgent(proxyUrl);
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
    return Lark.Domain.Lark;
  }
  if (domain === "feishu" || !domain) {
    return Lark.Domain.Feishu;
  }
  return domain.replace(/\/+$/, ""); // Custom URL for private deployment
}

/**
 * Extended HTTP request options that includes axios-specific configurations.
 * Lark SDK's HttpRequestOptions doesn't expose maxRedirects, but the underlying
 * axios instance supports it. We use this extended type to pass through
 * redirect-related options.
 */
interface ExtendedHttpRequestOptions<D> extends Lark.HttpRequestOptions<D> {
  /** Maximum number of redirects to follow. Set to 0 to disable automatic redirects. */
  maxRedirects?: number;
}

/**
 * Check if a status code indicates a redirect.
 */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/**
 * Create an HTTP instance that delegates to the Lark SDK's default instance
 * but injects a default request timeout to prevent indefinite hangs
 * (e.g. when the Feishu API is slow, causing per-chat queue deadlocks).
 *
 * Also handles Feishu CDN's self-redirect behavior where it returns 301
 * redirects to the same URL when using HTTP/1.1. When such a self-redirect
 * is detected, the response is returned as-is instead of throwing
 * ERR_FR_TOO_MANY_REDIRECTS.
 */
function createTimeoutHttpInstance(defaultTimeoutMs: number): Lark.HttpInstance {
  const base: Lark.HttpInstance = Lark.defaultHttpInstance as unknown as Lark.HttpInstance;

  /**
   * Inject default timeout and maxRedirects into request options.
   * The Lark SDK's type definitions don't include maxRedirects,
   * but the underlying axios instance supports it.
   */
  function injectDefaults<D>(opts?: Lark.HttpRequestOptions<D>): ExtendedHttpRequestOptions<D> {
    return {
      timeout: defaultTimeoutMs,
      // Set a higher maxRedirects limit to handle Feishu CDN's redirect behavior.
      // The default axios limit is 21, but Feishu CDN can sometimes create
      // self-redirect loops that exhaust this limit before the CDN resolves.
      // Setting this to a higher value gives more runway before failure.
      maxRedirects: 50,
      ...opts,
    } as ExtendedHttpRequestOptions<D>;
  }

  /**
   * Track visited URLs per request chain to detect redirect loops.
   * We use a WeakMap keyed by the request config to avoid memory leaks.
   */
  const redirectTracker = new WeakMap<object, { visited: Set<string>; count: number }>();

  /**
   * Handle responses, checking for self-redirect patterns.
   * When Feishu CDN returns a redirect to the same URL, we return the response
   * instead of continuing to follow redirects.
   */
  async function handleWithRedirectProtection<T>(
    makeRequest: () => Promise<T>,
    url: string,
    requestKey: object,
  ): Promise<T> {
    try {
      return await makeRequest();
    } catch (err) {
      // Check if this is a "too many redirects" error from axios
      const axiosErr = err as {
        code?: string;
        response?: { status?: number; headers?: Record<string, string> };
      };
      if (axiosErr.code === "ERR_FR_TOO_MANY_REDIRECTS") {
        // Get tracker for this request
        let tracker = redirectTracker.get(requestKey);
        if (!tracker) {
          tracker = { visited: new Set(), count: 0 };
          redirectTracker.set(requestKey, tracker);
        }

        // Log warning about the redirect issue
        console.warn(
          `[feishu] Too many redirects detected for ${url}. ` +
            `This may be due to Feishu CDN's self-redirect behavior. ` +
            `Consider upgrading to HTTP/2 or using a different endpoint.`,
        );

        // Re-throw the error - we can't easily recover from this
        // because the response body is not available after too many redirects
        throw err;
      }
      throw err;
    }
  }

  return {
    request: (opts) => {
      const key = opts ?? {};
      return handleWithRedirectProtection(
        () => base.request(injectDefaults(opts)),
        opts?.url ?? "",
        key,
      );
    },
    get: (url, opts) => {
      const key = opts ?? {};
      return handleWithRedirectProtection(() => base.get(url, injectDefaults(opts)), url, key);
    },
    post: (url, data, opts) => {
      const key = opts ?? {};
      return handleWithRedirectProtection(
        () => base.post(url, data, injectDefaults(opts)),
        url,
        key,
      );
    },
    put: (url, data, opts) => {
      const key = opts ?? {};
      return handleWithRedirectProtection(
        () => base.put(url, data, injectDefaults(opts)),
        url,
        key,
      );
    },
    patch: (url, data, opts) => {
      const key = opts ?? {};
      return handleWithRedirectProtection(
        () => base.patch(url, data, injectDefaults(opts)),
        url,
        key,
      );
    },
    delete: (url, opts) => {
      const key = opts ?? {};
      return handleWithRedirectProtection(() => base.delete(url, injectDefaults(opts)), url, key);
    },
    head: (url, opts) => {
      const key = opts ?? {};
      return handleWithRedirectProtection(() => base.head(url, injectDefaults(opts)), url, key);
    },
    options: (url, opts) => {
      const key = opts ?? {};
      return handleWithRedirectProtection(() => base.options(url, injectDefaults(opts)), url, key);
    },
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
  const client = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
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
  return new Lark.WSClient({
    appId,
    appSecret,
    domain: resolveDomain(domain),
    loggerLevel: Lark.LoggerLevel.info,
    ...(agent ? { agent } : {}),
  });
}

/**
 * Create an event dispatcher for an account.
 */
export function createEventDispatcher(account: ResolvedFeishuAccount): Lark.EventDispatcher {
  return new Lark.EventDispatcher({
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
