/**
 * Telegram inline button utilities for model selection.
 *
 * Callback data patterns (max 64 bytes for Telegram):
 * - mdl_prov              - show providers list
 * - mdl_list_{prov}_{pg}  - show models for provider (page N, 1-indexed)
 * - mdl_sel_{provider/id} - select model (standard)
 * - mdl_sel/{model}       - select model (compact fallback when standard is >64 bytes)
 * - mdl_back              - back to providers list
 */
export type ButtonRow = Array<{
    text: string;
    callback_data: string;
}>;
export type ParsedModelCallback = {
    type: "providers";
} | {
    type: "list";
    provider: string;
    page: number;
} | {
    type: "select";
    provider?: string;
    model: string;
} | {
    type: "back";
};
export type ProviderInfo = {
    id: string;
    count: number;
};
export type ResolveModelSelectionResult = {
    kind: "resolved";
    provider: string;
    model: string;
} | {
    kind: "ambiguous";
    model: string;
    matchingProviders: string[];
};
export type ModelsKeyboardParams = {
    provider: string;
    models: readonly string[];
    currentModel?: string;
    currentPage: number;
    totalPages: number;
    pageSize?: number;
};
/**
 * Parse a model callback_data string into a structured object.
 * Returns null if the data doesn't match a known pattern.
 */
export declare function parseModelCallbackData(data: string): ParsedModelCallback | null;
export declare function buildModelSelectionCallbackData(params: {
    provider: string;
    model: string;
}): string | null;
export declare function resolveModelSelection(params: {
    callback: Extract<ParsedModelCallback, {
        type: "select";
    }>;
    providers: readonly string[];
    byProvider: ReadonlyMap<string, ReadonlySet<string>>;
}): ResolveModelSelectionResult;
/**
 * Build provider selection keyboard with 2 providers per row.
 */
export declare function buildProviderKeyboard(providers: ProviderInfo[]): ButtonRow[];
/**
 * Build model list keyboard with pagination and back button.
 */
export declare function buildModelsKeyboard(params: ModelsKeyboardParams): ButtonRow[];
/**
 * Build "Browse providers" button for /model summary.
 */
export declare function buildBrowseProvidersButton(): ButtonRow[];
/**
 * Get page size for model list pagination.
 */
export declare function getModelsPageSize(): number;
/**
 * Calculate total pages for a model list.
 */
export declare function calculateTotalPages(totalModels: number, pageSize?: number): number;
