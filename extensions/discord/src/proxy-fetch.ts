// Discord plugin module implements proxy fetch behavior.
import { isIP } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { makeProxyFetch } from "openclaw/plugin-sdk/fetch-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedDiscordAccount } from "./accounts.js";

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

function resolveDiscordProxyFetchByUrl(
  proxyUrl: string | undefined,
  runtime?: Pick<RuntimeEnv, "error">,
): typeof fetch | undefined {
  return withValidatedDiscordProxy(proxyUrl, runtime, (proxy) => makeProxyFetch(proxy));
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
    runtime?.error?.(danger(`discord: invalid rest proxy: ${String(err)}`));
    return undefined;
  }
}

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
  if (!isLoopbackProxyHostname(parsed.hostname) && !matchesConfiguredProcessProxy(parsed)) {
    throw new Error("Proxy URL must target loopback or the configured process proxy");
  }
  return proxyUrl;
}

function isLoopbackProxyHostname(hostname: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(hostname);
  if (!normalized) {
    return false;
  }
  const bracketless =
    normalized.startsWith("[") && normalized.endsWith("]") ? normalized.slice(1, -1) : normalized;
  if (bracketless === "localhost") {
    return true;
  }
  const ipFamily = isIP(bracketless);
  if (ipFamily === 4) {
    return bracketless.startsWith("127.");
  }
  if (ipFamily === 6) {
    return bracketless === "::1" || bracketless === "0:0:0:0:0:0:0:1";
  }
  return false;
}

function matchesConfiguredProcessProxy(proxyUrl: URL): boolean {
  for (const configured of configuredDiscordProxyUrls(process.env)) {
    if (configured && proxyEndpointMatches(proxyUrl, configured)) {
      return true;
    }
  }
  return false;
}

function configuredDiscordProxyUrls(env: NodeJS.ProcessEnv): string[] {
  return [normalizeProxyEnvValue(env.OPENCLAW_PROXY_URL), resolveHttpsProxyEnvUrl(env)].filter(
    (value): value is string => typeof value === "string",
  );
}

function resolveHttpsProxyEnvUrl(env: NodeJS.ProcessEnv): string | undefined {
  const httpsProxy = proxyEnvValueWithLowercasePrecedence(env.https_proxy, env.HTTPS_PROXY);
  const httpProxy = proxyEnvValueWithLowercasePrecedence(env.http_proxy, env.HTTP_PROXY);
  const allProxy = proxyEnvValueWithLowercasePrecedence(env.all_proxy, env.ALL_PROXY);
  return httpsProxy ?? httpProxy ?? allProxy ?? undefined;
}

function proxyEnvValueWithLowercasePrecedence(
  lowercaseValue: string | undefined,
  uppercaseValue: string | undefined,
): string | null | undefined {
  const lowercase = normalizeProxyEnvValue(lowercaseValue);
  return lowercase !== undefined ? lowercase : normalizeProxyEnvValue(uppercaseValue);
}

function normalizeProxyEnvValue(value: string | undefined): string | null | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function proxyEndpointMatches(proxyUrl: URL, configuredProxyUrl: string): boolean {
  let configured: URL;
  try {
    configured = new URL(configuredProxyUrl);
  } catch {
    return false;
  }
  if (!["http:", "https:"].includes(configured.protocol)) {
    return false;
  }
  return normalizedProxyUrl(proxyUrl) === normalizedProxyUrl(configured);
}

function normalizedProxyUrl(proxyUrl: URL): string {
  const normalized = new URL(proxyUrl.href);
  normalized.hostname = normalizeLowercaseStringOrEmpty(normalized.hostname);
  normalized.port = effectiveProxyPort(normalized);
  return normalized.href;
}

function effectiveProxyPort(proxyUrl: URL): string {
  if (proxyUrl.port) {
    return proxyUrl.port;
  }
  return proxyUrl.protocol === "https:" ? "443" : "80";
}
