import * as Lark from "@larksuiteoapi/node-sdk";
import { HttpsProxyAgent } from "https-proxy-agent";
const FEISHU_HTTP_TIMEOUT_MS = 3e4;
const FEISHU_HTTP_TIMEOUT_MAX_MS = 3e5;
const FEISHU_HTTP_TIMEOUT_ENV_VAR = "OPENCLAW_FEISHU_HTTP_TIMEOUT_MS";
function getWsProxyAgent() {
  const proxyUrl = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  if (!proxyUrl) return void 0;
  return new HttpsProxyAgent(proxyUrl);
}
const clientCache = /* @__PURE__ */ new Map();
function resolveDomain(domain) {
  if (domain === "lark") {
    return Lark.Domain.Lark;
  }
  if (domain === "feishu" || !domain) {
    return Lark.Domain.Feishu;
  }
  return domain.replace(/\/+$/, "");
}
function createTimeoutHttpInstance(defaultTimeoutMs) {
  const base = Lark.defaultHttpInstance;
  function injectTimeout(opts) {
    return { timeout: defaultTimeoutMs, ...opts };
  }
  return {
    request: (opts) => base.request(injectTimeout(opts)),
    get: (url, opts) => base.get(url, injectTimeout(opts)),
    post: (url, data, opts) => base.post(url, data, injectTimeout(opts)),
    put: (url, data, opts) => base.put(url, data, injectTimeout(opts)),
    patch: (url, data, opts) => base.patch(url, data, injectTimeout(opts)),
    delete: (url, opts) => base.delete(url, injectTimeout(opts)),
    head: (url, opts) => base.head(url, injectTimeout(opts)),
    options: (url, opts) => base.options(url, injectTimeout(opts))
  };
}
function resolveConfiguredHttpTimeoutMs(creds) {
  const clampTimeout = (value) => {
    const rounded = Math.floor(value);
    return Math.min(Math.max(rounded, 1), FEISHU_HTTP_TIMEOUT_MAX_MS);
  };
  const fromDirectField = creds.httpTimeoutMs;
  if (typeof fromDirectField === "number" && Number.isFinite(fromDirectField) && fromDirectField > 0) {
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
function createFeishuClient(creds) {
  const { accountId = "default", appId, appSecret, domain } = creds;
  const defaultHttpTimeoutMs = resolveConfiguredHttpTimeoutMs(creds);
  if (!appId || !appSecret) {
    throw new Error(`Feishu credentials not configured for account "${accountId}"`);
  }
  const cached = clientCache.get(accountId);
  if (cached && cached.config.appId === appId && cached.config.appSecret === appSecret && cached.config.domain === domain && cached.config.httpTimeoutMs === defaultHttpTimeoutMs) {
    return cached.client;
  }
  const client = new Lark.Client({
    appId,
    appSecret,
    appType: Lark.AppType.SelfBuild,
    domain: resolveDomain(domain),
    httpInstance: createTimeoutHttpInstance(defaultHttpTimeoutMs)
  });
  clientCache.set(accountId, {
    client,
    config: { appId, appSecret, domain, httpTimeoutMs: defaultHttpTimeoutMs }
  });
  return client;
}
function createFeishuWSClient(account) {
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
    ...agent ? { agent } : {}
  });
}
function createEventDispatcher(account) {
  return new Lark.EventDispatcher({
    encryptKey: account.encryptKey,
    verificationToken: account.verificationToken
  });
}
function getFeishuClient(accountId) {
  return clientCache.get(accountId)?.client ?? null;
}
function clearClientCache(accountId) {
  if (accountId) {
    clientCache.delete(accountId);
  } else {
    clientCache.clear();
  }
}
export {
  FEISHU_HTTP_TIMEOUT_ENV_VAR,
  FEISHU_HTTP_TIMEOUT_MAX_MS,
  FEISHU_HTTP_TIMEOUT_MS,
  clearClientCache,
  createEventDispatcher,
  createFeishuClient,
  createFeishuWSClient,
  getFeishuClient
};
