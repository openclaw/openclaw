import type { TelegramNetworkConfig } from "../config/types.telegram.js";
export declare const TELEGRAM_DISABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_DISABLE_AUTO_SELECT_FAMILY";
export declare const TELEGRAM_ENABLE_AUTO_SELECT_FAMILY_ENV = "OPENCLAW_TELEGRAM_ENABLE_AUTO_SELECT_FAMILY";
export declare const TELEGRAM_DNS_RESULT_ORDER_ENV = "OPENCLAW_TELEGRAM_DNS_RESULT_ORDER";
export type TelegramAutoSelectFamilyDecision = {
    value: boolean | null;
    source?: string;
};
export type TelegramDnsResultOrderDecision = {
    value: string | null;
    source?: string;
};
export declare function resolveTelegramAutoSelectFamilyDecision(params?: {
    network?: TelegramNetworkConfig;
    env?: NodeJS.ProcessEnv;
    nodeMajor?: number;
}): TelegramAutoSelectFamilyDecision;
/**
 * Resolve DNS result order setting for Telegram network requests.
 * Some networks/ISPs have issues with IPv6 causing fetch failures.
 * Setting "ipv4first" prioritizes IPv4 addresses in DNS resolution.
 *
 * Priority:
 * 1. Environment variable OPENCLAW_TELEGRAM_DNS_RESULT_ORDER
 * 2. Config: channels.telegram.network.dnsResultOrder
 * 3. Default: "ipv4first" on Node 22+ (to work around common IPv6 issues)
 */
export declare function resolveTelegramDnsResultOrderDecision(params?: {
    network?: TelegramNetworkConfig;
    env?: NodeJS.ProcessEnv;
    nodeMajor?: number;
}): TelegramDnsResultOrderDecision;
export declare function resetTelegramNetworkConfigStateForTests(): void;
