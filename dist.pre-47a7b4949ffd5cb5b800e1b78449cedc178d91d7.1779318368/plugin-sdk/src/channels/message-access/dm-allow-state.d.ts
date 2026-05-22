import type { ChannelId } from "../plugins/types.public.js";
export declare function resolveDmAllowAuditState(params: {
    provider: ChannelId;
    accountId: string;
    allowFrom?: Array<string | number> | null;
    dmPolicy?: string | null;
    normalizeEntry?: (raw: string) => string;
    readStore?: (provider: ChannelId, accountId: string) => Promise<string[]>;
}): Promise<{
    configAllowFrom: string[];
    hasWildcard: boolean;
    allowCount: number;
    isMultiUserDm: boolean;
}>;
