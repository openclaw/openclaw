type ModelDisplaySelectionParams = {
    runtimeProvider?: unknown;
    runtimeModel?: unknown;
    overrideProvider?: unknown;
    overrideModel?: unknown;
    fallbackModel?: unknown;
};
export declare function resolveModelDisplayRef(params: ModelDisplaySelectionParams): string | undefined;
export declare function resolveModelDisplayName(params: ModelDisplaySelectionParams): string;
type SessionInfoModelSelectionParams = {
    currentProvider?: unknown;
    currentModel?: unknown;
    defaultProvider?: unknown;
    defaultModel?: unknown;
    entryProvider?: unknown;
    entryModel?: unknown;
    overrideProvider?: unknown;
    overrideModel?: unknown;
};
export declare function resolveSessionInfoModelSelection(params: SessionInfoModelSelectionParams): {
    modelProvider?: string;
    model?: string;
};
export {};
