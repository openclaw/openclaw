type ModelDisplaySelectionParams = {
    runtimeProvider?: string | null;
    runtimeModel?: string | null;
    overrideProvider?: string | null;
    overrideModel?: string | null;
    fallbackModel?: string | null;
};
export declare function resolveModelDisplayRef(params: ModelDisplaySelectionParams): string | undefined;
export declare function resolveModelDisplayName(params: ModelDisplaySelectionParams): string;
type SessionInfoModelSelectionParams = {
    currentProvider?: string | null;
    currentModel?: string | null;
    defaultProvider?: string | null;
    defaultModel?: string | null;
    entryProvider?: string | null;
    entryModel?: string | null;
    overrideProvider?: string | null;
    overrideModel?: string | null;
};
export declare function resolveSessionInfoModelSelection(params: SessionInfoModelSelectionParams): {
    modelProvider?: string;
    model?: string;
};
export {};
