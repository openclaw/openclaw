import type { SessionEntry } from "../config/sessions.js";
export type ModelOverrideSelection = {
    provider: string;
    model: string;
    isDefault?: boolean;
};
export declare function applyModelOverrideToSessionEntry(params: {
    entry: SessionEntry;
    selection: ModelOverrideSelection;
    profileOverride?: string;
    profileOverrideSource?: "auto" | "user";
    preserveAuthProfileOverride?: boolean;
    selectionSource?: "auto" | "user";
    markLiveSwitchPending?: boolean;
}): {
    updated: boolean;
};
export declare function repairProviderWrappedModelOverride(params: {
    entry: SessionEntry;
    defaultProvider: string;
    defaultModel?: string;
}): {
    updated: boolean;
};
