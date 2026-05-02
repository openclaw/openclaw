import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedDiscordAccount } from "./accounts.js";
import {
  hasDiscordManagedProxyConfig,
  resolveDiscordFetch,
  validateDiscordProxyUrl,
} from "./fetch.js";
import { makeProxyFetch } from "./proxy.js";

function resolveDiscordProxyUrl(
  account: Pick<ResolvedDiscordAccount, "config">,
  cfg: OpenClawConfig,
): string | undefined {
  const accountProxy = account.config.proxy?.trim();
  if (accountProxy) {
    return accountProxy;
  }
  const channelProxy = cfg?.channels?.discord?.proxy;
  if (typeof channelProxy !== "string") {
    return undefined;
  }
  const trimmed = channelProxy.trim();
  return trimmed || undefined;
}

export function resolveDiscordProxyFetchByUrl(
  proxyUrl: string | undefined,
  runtime?: Pick<RuntimeEnv, "error">,
): typeof fetch | undefined {
  const explicitProxy = proxyUrl?.trim();
  if (explicitProxy) {
    return withValidatedDiscordProxy(explicitProxy, runtime, (proxy) =>
      resolveDiscordFetch(makeProxyFetch(proxy)),
    );
  }
  if (!hasDiscordManagedProxyConfig()) {
    return undefined;
  }
  try {
    return resolveDiscordFetch(undefined);
  } catch (err) {
    runtime?.error?.(danger(`discord: invalid proxy: ${String(err)}`));
    return undefined;
  }
}

export function resolveDiscordProxyFetchForAccount(
  account: Pick<ResolvedDiscordAccount, "config">,
  cfg: OpenClawConfig,
  runtime?: Pick<RuntimeEnv, "error">,
): typeof fetch | undefined {
  return resolveDiscordProxyFetchByUrl(resolveDiscordProxyUrl(account, cfg), runtime);
}

export function withValidatedDiscordProxy<T>(
  proxyUrl: string | undefined,
  runtime: Pick<RuntimeEnv, "error"> | undefined,
  createValue: (proxyUrl: string) => T,
): T | undefined {
  const proxy = proxyUrl?.trim();
  if (!proxy) {
    return undefined;
  }
  try {
    validateDiscordProxyUrl(proxy);
    return createValue(proxy);
  } catch (err) {
    runtime?.error?.(danger(`discord: invalid proxy: ${String(err)}`));
    return undefined;
  }
}

export { validateDiscordProxyUrl };
