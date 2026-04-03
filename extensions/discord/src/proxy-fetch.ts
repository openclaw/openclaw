import { type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { makeProxyFetch } from "openclaw/plugin-sdk/infra-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import type { ResolvedDiscordAccount } from "./accounts.js";

export function resolveDiscordProxyUrl(
  account: Pick<ResolvedDiscordAccount, "config">,
  cfg?: OpenClawConfig,
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
  const proxy = proxyUrl?.trim();
  if (!proxy) {
    return undefined;
  }
  try {
    return makeProxyFetch(proxy);
  } catch (err) {
    runtime?.error?.(danger(`discord: invalid rest proxy: ${String(err)}`));
    return undefined;
  }
}

export function resolveDiscordProxyFetchForAccount(
  account: Pick<ResolvedDiscordAccount, "config">,
  cfg?: OpenClawConfig,
  runtime?: Pick<RuntimeEnv, "error">,
): typeof fetch | undefined {
  return resolveDiscordProxyFetchByUrl(resolveDiscordProxyUrl(account, cfg), runtime);
}
