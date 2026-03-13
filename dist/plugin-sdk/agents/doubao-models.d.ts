import type { ModelDefinitionConfig } from "../config/types.js";
export declare const DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export declare const DOUBAO_CODING_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
export declare const DOUBAO_DEFAULT_MODEL_ID = "doubao-seed-1-8-251228";
export declare const DOUBAO_CODING_DEFAULT_MODEL_ID = "ark-code-latest";
export declare const DOUBAO_DEFAULT_MODEL_REF = "volcengine/doubao-seed-1-8-251228";
export declare const DOUBAO_DEFAULT_COST: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};
/**
 * Complete catalog of Volcano Engine models.
 *
 * Volcano Engine provides access to models
 * through the API. Authentication requires a Volcano Engine API Key.
 */
export declare const DOUBAO_MODEL_CATALOG: readonly [{
    readonly id: "doubao-seed-code-preview-251028";
    readonly name: "doubao-seed-code-preview-251028";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 256000;
    readonly maxTokens: 4096;
}, {
    readonly id: "doubao-seed-1-8-251228";
    readonly name: "Doubao Seed 1.8";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 256000;
    readonly maxTokens: 4096;
}, {
    readonly id: "kimi-k2-5-260127";
    readonly name: "Kimi K2.5";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 256000;
    readonly maxTokens: 4096;
}, {
    readonly id: "glm-4-7-251222";
    readonly name: "GLM 4.7";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 200000;
    readonly maxTokens: 4096;
}, {
    readonly id: "deepseek-v3-2-251201";
    readonly name: "DeepSeek V3.2";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 128000;
    readonly maxTokens: 4096;
}];
export type DoubaoCatalogEntry = (typeof DOUBAO_MODEL_CATALOG)[number];
export type DoubaoCodingCatalogEntry = (typeof DOUBAO_CODING_MODEL_CATALOG)[number];
export declare function buildDoubaoModelDefinition(entry: DoubaoCatalogEntry | DoubaoCodingCatalogEntry): ModelDefinitionConfig;
export declare const DOUBAO_CODING_MODEL_CATALOG: readonly [{
    readonly id: "ark-code-latest";
    readonly name: "Ark Coding Plan";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 4096;
}, {
    readonly id: "doubao-seed-code";
    readonly name: "Doubao Seed Code";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 4096;
}, {
    readonly id: "glm-4.7";
    readonly name: "GLM 4.7 Coding";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 200000;
    readonly maxTokens: 4096;
}, {
    readonly id: "kimi-k2-thinking";
    readonly name: "Kimi K2 Thinking";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 4096;
}, {
    readonly id: "kimi-k2.5";
    readonly name: "Kimi K2.5 Coding";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 4096;
}, {
    readonly id: "doubao-seed-code-preview-251028";
    readonly name: "Doubao Seed Code Preview";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 4096;
}];
