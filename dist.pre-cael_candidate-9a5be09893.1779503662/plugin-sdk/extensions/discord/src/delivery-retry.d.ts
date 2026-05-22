import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
export declare function isRetryableDiscordDeliveryError(err: unknown): boolean;
export declare function withDiscordDeliveryRetry<T>(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    fn: () => Promise<T>;
}): Promise<T>;
