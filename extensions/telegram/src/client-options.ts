import type { ApiClientOptions } from "grammy";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedTelegramAccount } from "./accounts.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import { asTelegramClientFetch, createTelegramClientFetch } from "./client-fetch.js";
import { resolveTelegramTransport } from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";

const telegramClientOptionsCache = new Map<string, ApiClientOptions | undefined>();
const MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE = 64;

export function resetTelegramClientOptionsCacheForTests(): void {
  telegramClientOptionsCache.clear();
}

function shouldUseTelegramClientOptionsCache(): boolean {
  return !process.env.VITEST && process.env.NODE_ENV !== "test";
}

function buildTelegramClientOptionsCacheKey(params: {
  account: ResolvedTelegramAccount;
  timeoutSeconds?: number;
}): string {
  const proxyKey = params.account.config.proxy?.trim() ?? "";
  const autoSelectFamily = params.account.config.network?.autoSelectFamily;
  const autoSelectFamilyKey =
    typeof autoSelectFamily === "boolean" ? String(autoSelectFamily) : "default";
  const dnsResultOrderKey = params.account.config.network?.dnsResultOrder ?? "default";
  const apiRootKey = params.account.config.apiRoot?.trim() ?? "";
  const timeoutSecondsKey =
    typeof params.timeoutSeconds === "number" ? String(params.timeoutSeconds) : "default";
  return `${params.account.accountId}::${proxyKey}::${autoSelectFamilyKey}::${dnsResultOrderKey}::${apiRootKey}::${timeoutSecondsKey}`;
}

function setCachedTelegramClientOptions(
  cacheKey: string,
  clientOptions: ApiClientOptions | undefined,
): ApiClientOptions | undefined {
  telegramClientOptionsCache.set(cacheKey, clientOptions);
  if (telegramClientOptionsCache.size > MAX_TELEGRAM_CLIENT_OPTIONS_CACHE_SIZE) {
    const oldestKey = telegramClientOptionsCache.keys().next().value;
    if (oldestKey !== undefined) {
      telegramClientOptionsCache.delete(oldestKey);
    }
  }
  return clientOptions;
}

export function resolveTelegramClientOptions(
  account: ResolvedTelegramAccount,
): ApiClientOptions | undefined {
  const timeoutSeconds =
    typeof account.config.timeoutSeconds === "number" &&
    Number.isFinite(account.config.timeoutSeconds)
      ? Math.max(1, Math.floor(account.config.timeoutSeconds))
      : undefined;

  const cacheEnabled = shouldUseTelegramClientOptionsCache();
  const cacheKey = cacheEnabled
    ? buildTelegramClientOptionsCacheKey({
        account,
        timeoutSeconds,
      })
    : null;
  if (cacheKey && telegramClientOptionsCache.has(cacheKey)) {
    return telegramClientOptionsCache.get(cacheKey);
  }

  const proxyUrl = normalizeOptionalString(account.config.proxy);
  const proxyFetch = proxyUrl ? makeProxyFetch(proxyUrl) : undefined;
  const apiRoot = normalizeOptionalString(account.config.apiRoot);
  const normalizedApiRoot = apiRoot ? normalizeTelegramApiRoot(apiRoot) : undefined;
  const transport = resolveTelegramTransport(proxyFetch, {
    network: account.config.network,
  });
  const fetchImpl = createTelegramClientFetch({
    fetchImpl: asTelegramClientFetch(transport.fetch),
    timeoutSeconds,
    transport,
  });
  const clientOptions =
    fetchImpl || timeoutSeconds || normalizedApiRoot
      ? {
          ...(fetchImpl ? { fetch: asTelegramClientFetch(fetchImpl) } : {}),
          ...(timeoutSeconds ? { timeoutSeconds } : {}),
          ...(normalizedApiRoot ? { apiRoot: normalizedApiRoot } : {}),
        }
      : undefined;
  if (cacheKey) {
    return setCachedTelegramClientOptions(cacheKey, clientOptions);
  }
  return clientOptions;
}
