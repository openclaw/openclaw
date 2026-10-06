import * as dns from "node:dns";
import process from "node:process";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";
import { isTruthyEnvValue, isWSL2Sync } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

const TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY";
const TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY";
export const TELEGRAM_DNS_RESULT_ORDER_ENV = "OPENCLAW_TELEGRAM_DNS_RESULT_ORDER";

type TelegramAutoSelectFamilyDecision = {
  value: boolean;
  source: string;
};

let wsl2SyncCache: boolean | undefined;

function isWSL2SyncCached(): boolean {
  return (wsl2SyncCache ??= isWSL2Sync());
}

type TelegramDnsResultOrderDecision = {
  value: "ipv4first" | "verbatim";
  source: string;
};

export function resolveTelegramAutoSelectFamilyDecision(params?: {
  network?: TelegramNetworkConfig;
  env?: NodeJS.ProcessEnv;
}): TelegramAutoSelectFamilyDecision {
  const env = params?.env ?? process.env;

  if (isTruthyEnvValue(env[TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { value: true, source: `env:${TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV}` };
  }
  if (isTruthyEnvValue(env[TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV])) {
    return { value: false, source: `env:${TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV}` };
  }
  if (typeof params?.network?.autoSelectFamily === "boolean") {
    return { value: params.network.autoSelectFamily, source: "config" };
  }
  // WSL2 has unstable IPv6 connectivity; disable autoSelectFamily to use IPv4 directly
  if (isWSL2SyncCached()) {
    return { value: false, source: "default-wsl2" };
  }
  return { value: true, source: "default-node22" };
}

/**
 * Resolve DNS result order setting for Telegram network requests.
 * Some networks/ISPs have issues with IPv6 causing fetch failures.
 * Setting "ipv4first" prioritizes IPv4 addresses in DNS resolution.
 *
 * Priority:
 * 1. Environment variable OPENCLAW_TELEGRAM_DNS_RESULT_ORDER
 * 2. Config: channels.telegram.network.dnsResultOrder
 * 3. Process default: dns.getDefaultResultOrder()
 * 4. Default: "ipv4first" on Node 22+ (to work around common IPv6 issues)
 */
export function resolveTelegramDnsResultOrderDecision(params?: {
  network?: TelegramNetworkConfig;
}): TelegramDnsResultOrderDecision {
  const envValue = normalizeOptionalLowercaseString(process.env[TELEGRAM_DNS_RESULT_ORDER_ENV]);
  if (envValue === "ipv4first" || envValue === "verbatim") {
    return { value: envValue, source: `env:${TELEGRAM_DNS_RESULT_ORDER_ENV}` };
  }

  const configValue = normalizeOptionalLowercaseString(params?.network?.dnsResultOrder);
  if (configValue === "ipv4first" || configValue === "verbatim") {
    return { value: configValue, source: "config" };
  }

  const processDefaultValue = normalizeOptionalLowercaseString(dns.getDefaultResultOrder());
  if (processDefaultValue === "ipv4first" || processDefaultValue === "verbatim") {
    return { value: processDefaultValue, source: "process-default" };
  }

  return { value: "ipv4first", source: "default-node22" };
}
