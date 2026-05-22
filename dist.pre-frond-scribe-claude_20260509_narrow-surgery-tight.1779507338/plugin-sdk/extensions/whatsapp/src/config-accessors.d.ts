import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export declare function resolveWhatsAppConfigAllowFrom(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): string[];
export declare function formatWhatsAppConfigAllowFromEntries(allowFrom: Array<string | number>): string[];
export declare function resolveWhatsAppConfigDefaultTo(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
}): string | undefined;
