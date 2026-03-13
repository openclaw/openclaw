import type { OpenClawConfig } from "../config/config.js";
import type { LineGroupConfig } from "./types.js";
export declare function resolveLineGroupLookupIds(groupId?: string | null): string[];
export declare function resolveLineGroupConfigEntry<T>(groups: Record<string, T | undefined> | undefined, params: {
    groupId?: string | null;
    roomId?: string | null;
}): T | undefined;
export declare function resolveLineGroupsConfig(cfg: OpenClawConfig, accountId?: string | null): Record<string, LineGroupConfig | undefined> | undefined;
export declare function resolveExactLineGroupConfigKey(params: {
    cfg: OpenClawConfig;
    accountId?: string | null;
    groupId?: string | null;
}): string | undefined;
export declare function resolveLineGroupHistoryKey(params: {
    groupId?: string | null;
    roomId?: string | null;
}): string | undefined;
