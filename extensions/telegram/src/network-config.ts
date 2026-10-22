import * as dns from "node:dns";
import process from "node:process";
import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-contracts";
import { isTruthyEnvValue, isWSL2Sync } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalLowercaseString } from "openclaw/plugin-sdk/string-coerce-runtime";

const TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY";
const TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY";
export const TELEGRAM_DNS_RESULT_ORDER_ENV = "OPENCLAW_TELEGRAM_DNS_RESULT_ORDER";

let wsl2SyncCache: boolean | undefined;

type TelegramDnsResultOrderDecision = {
  value: "ipv4first" | "ipv6first" | "verbatim";
  source: string;
};

export function resolveTelegramAutoSelectFamilyDecision(params?: {
  network?: TelegramNetworkConfig;
}): boolean {
  if (isTruthyEnvValue(process.env[TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV])) {
    return true;
  }
  if (isTruthyEnvValue(process.env[TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV])) {
    return false;
  }
  if (typeof params?.network?.autoSelectFamily === "boolean") {
    return params.network.autoSelectFamily;
  }
  // WSL2 has unstable IPv6 connectivity; disable autoSelectFamily to use IPv4 directly
  if ((wsl2SyncCache ??= isWSL2Sync())) {
    return false;
  }
  // DNS ordering alone does not stop Node from racing the other address family.
  return resolveTelegramDnsResultOrderDecision(params).value !== "ipv4first";
}

// Default to IPv4 first to work around networks with broken IPv6 connectivity.
export function resolveTelegramDnsResultOrderDecision(params?: {
  network?: TelegramNetworkConfig;
}): TelegramDnsResultOrderDecision {
  for (const [source, read] of [
    [`env:${TELEGRAM_DNS_RESULT_ORDER_ENV}`, () => process.env[TELEGRAM_DNS_RESULT_ORDER_ENV]],
    ["config", () => params?.network?.dnsResultOrder],
    ["process-default", () => dns.getDefaultResultOrder()],
  ] as const) {
    const value = normalizeOptionalLowercaseString(read());
    if (
      value === "ipv4first" ||
      value === "verbatim" ||
      (source === "process-default" && value === "ipv6first")
    ) {
      return { value, source };
    }
  }
  return { value: "ipv4first", source: "default-node22" };
}
