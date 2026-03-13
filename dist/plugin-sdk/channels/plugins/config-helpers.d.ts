import type { OpenClawConfig } from "../../config/config.js";
export declare function setAccountEnabledInConfigSection(params: {
    cfg: OpenClawConfig;
    sectionKey: string;
    accountId: string;
    enabled: boolean;
    allowTopLevel?: boolean;
}): OpenClawConfig;
export declare function deleteAccountFromConfigSection(params: {
    cfg: OpenClawConfig;
    sectionKey: string;
    accountId: string;
    clearBaseFields?: string[];
}): OpenClawConfig;
export declare function clearAccountEntryFields<TAccountEntry extends object>(params: {
    accounts?: Record<string, TAccountEntry>;
    accountId: string;
    fields: string[];
    isValueSet?: (value: unknown) => boolean;
    markClearedOnFieldPresence?: boolean;
}): {
    nextAccounts?: Record<string, TAccountEntry>;
    changed: boolean;
    cleared: boolean;
};
