export declare const KILOCODE_BASE_URL = "https://api.kilo.ai/api/gateway/";
export declare const KILOCODE_DEFAULT_MODEL_ID = "anthropic/claude-opus-4.6";
export declare const KILOCODE_DEFAULT_MODEL_REF = "kilocode/anthropic/claude-opus-4.6";
export declare const KILOCODE_DEFAULT_MODEL_NAME = "Claude Opus 4.6";
export type KilocodeModelCatalogEntry = {
    id: string;
    name: string;
    reasoning: boolean;
    input: Array<"text" | "image">;
    contextWindow?: number;
    maxTokens?: number;
};
export declare const KILOCODE_MODEL_CATALOG: KilocodeModelCatalogEntry[];
export declare const KILOCODE_DEFAULT_CONTEXT_WINDOW = 1000000;
export declare const KILOCODE_DEFAULT_MAX_TOKENS = 128000;
export declare const KILOCODE_DEFAULT_COST: {
    readonly input: 0;
    readonly output: 0;
    readonly cacheRead: 0;
    readonly cacheWrite: 0;
};
