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
}): {
    updated: boolean;
};
