export declare const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
export declare const KILOCODE_DEFAULT_MODEL_ID = "kilo/auto";
export declare const KILOCODE_DEFAULT_MODEL_REF = "kilocode/kilo/auto";
export declare const KILOCODE_DEFAULT_MODEL_NAME = "Kilo Auto";
export type KilocodeModelCatalogEntry = {
    id: string;
    name: string;
    reasoning: boolean;
    input: Array<"text" | "image">;
    contextWindow?: number;
    maxTokens?: number;
};
/**
 * Static fallback catalog — used by the sync onboarding path and as a
 * fallback when dynamic model discovery from the gateway API fails.
 * The full model list is fetched dynamically by {@link discoverKilocodeModels}
 * in `src/agents/kilocode-models.ts`.
 */
export declare const KILOCODE_MODEL_CATALOG: KilocodeModelCatalogEntry[];
export declare const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1000000;
export declare const KILOCODE_DEFAULT_MAX_TOKENS = 128000;
export declare const KILOCODE_DEFAULT_COST: {
    readonly input: 0;
    readonly output: 0;
    readonly cacheRead: 0;
    readonly cacheWrite: 0;
};
