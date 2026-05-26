import type { ChannelAccountSnapshot } from "../plugins/types.public.js";
export type RuntimeChannelStatusPayload = {
    channelAccounts?: unknown;
};
export type RuntimeChannelAccount = Record<string, unknown>;
export declare function getRuntimeChannelAccounts(params: {
    payload: unknown;
    channelId: string;
}): RuntimeChannelAccount[];
export declare function normalizeRuntimeChannelAccountSnapshots(payload: unknown): Map<string, ChannelAccountSnapshot[]>;
export declare function resolveRuntimeChannelAccountId(account: RuntimeChannelAccount): string;
export declare function findRuntimeChannelAccount(params: {
    liveAccounts: RuntimeChannelAccount[];
    accountId: string;
}): RuntimeChannelAccount | null;
export declare function hasRuntimeCredentialAvailable(params: {
    liveAccounts: RuntimeChannelAccount[];
    accountId: string;
}): boolean;
export declare function markConfiguredUnavailableCredentialStatusesAvailable(account: unknown): Record<string, unknown>;
export declare function resolveChannelAccountStatusRows(params: {
    localAccountIds: string[];
    runtimeAccounts: ChannelAccountSnapshot[];
    resolveLocalSnapshot: (accountId: string) => Promise<ChannelAccountSnapshot>;
}): Promise<Array<{
    accountId: string;
    snapshot: ChannelAccountSnapshot;
    source: "gateway" | "config";
}>>;
