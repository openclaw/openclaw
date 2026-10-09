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
  if ((wsl2SyncCache ??= isWSL2Sync())) {
    return { value: false, source: "default-wsl2" };
  }
  return { value: true, source: "default-node22" };
}

// Default to IPv4 first to work around networks with broken IPv6 connectivity.
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
