import { isRecord } from "../../../utils.js";
import type { ChannelAccountSnapshot, ChannelStatusIssue } from "../types.js";
export { isRecord };
export declare function asString(value: unknown): string | undefined;
export declare function formatMatchMetadata(params: {
    matchKey?: unknown;
    matchSource?: unknown;
}): string | undefined;
export declare function appendMatchMetadata(message: string, params: {
    matchKey?: unknown;
    matchSource?: unknown;
}): string;
export declare function resolveEnabledConfiguredAccountId(account: {
    accountId?: unknown;
    enabled?: unknown;
    configured?: unknown;
}): string | null;
export declare function collectIssuesForEnabledAccounts<T extends {
    accountId?: unknown;
    enabled?: unknown;
}>(params: {
    accounts: ChannelAccountSnapshot[];
    readAccount: (value: ChannelAccountSnapshot) => T | null;
    collectIssues: (params: {
        account: T;
        accountId: string;
        issues: ChannelStatusIssue[];
    }) => void;
}): ChannelStatusIssue[];
