import type { OpenClawConfig } from "../../config/config.js";
export declare function applyAccountNameToChannelSection(params: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId: string;
    name?: string;
    alwaysUseAccounts?: boolean;
}): OpenClawConfig;
export declare function migrateBaseNameToDefaultAccount(params: {
    cfg: OpenClawConfig;
    channelKey: string;
    alwaysUseAccounts?: boolean;
}): OpenClawConfig;
export declare function applySetupAccountConfigPatch(params: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId: string;
    patch: Record<string, unknown>;
}): OpenClawConfig;
export declare function patchScopedAccountConfig(params: {
    cfg: OpenClawConfig;
    channelKey: string;
    accountId: string;
    patch: Record<string, unknown>;
    accountPatch?: Record<string, unknown>;
    ensureChannelEnabled?: boolean;
    ensureAccountEnabled?: boolean;
}): OpenClawConfig;
export declare function shouldMoveSingleAccountChannelKey(params: {
    channelKey: string;
    key: string;
}): boolean;
export declare function moveSingleAccountChannelSectionToDefaultAccount(params: {
    cfg: OpenClawConfig;
    channelKey: string;
}): OpenClawConfig;
