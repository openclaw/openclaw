import type { BaseProbeResult } from "../channels/plugins/types.js";
import type { TelegramNetworkConfig } from "../config/types.telegram.js";
export type TelegramProbe = BaseProbeResult & {
    status?: number | null;
    elapsedMs: number;
    bot?: {
        id?: number | null;
        username?: string | null;
        canJoinGroups?: boolean | null;
        canReadAllGroupMessages?: boolean | null;
        supportsInlineQueries?: boolean | null;
    };
    webhook?: {
        url?: string | null;
        hasCustomCert?: boolean | null;
    };
};
export type TelegramProbeOptions = {
    proxyUrl?: string;
    network?: TelegramNetworkConfig;
    accountId?: string;
};
export declare function resetTelegramProbeFetcherCacheForTests(): void;
export declare function probeTelegram(token: string, timeoutMs: number, proxyOrOptions?: string | TelegramProbeOptions): Promise<TelegramProbe>;
