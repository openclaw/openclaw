import type { BaseProbeResult } from "../channels/plugins/types.js";
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
export declare function probeTelegram(token: string, timeoutMs: number, proxyUrl?: string): Promise<TelegramProbe>;
