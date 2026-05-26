import type { ChannelDirectoryEntry } from "../channel-contract.js";
import type { OpenClawConfig } from "../config-types.js";
export type DirectoryListFn = (params: {
    cfg: OpenClawConfig;
    accountId?: string;
    query?: string | null;
    limit?: number | null;
}) => Promise<ChannelDirectoryEntry[]>;
export declare function expectDirectoryIds(listFn: DirectoryListFn, cfg: OpenClawConfig, expected: string[], options?: {
    sorted?: boolean;
}): Promise<void>;
