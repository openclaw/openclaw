import type { ModelDefinitionConfig } from "../config/types.js";
export declare const BYTEPLUS_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
export declare const BYTEPLUS_CODING_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/coding/v3";
export declare const BYTEPLUS_DEFAULT_MODEL_ID = "seed-1-8-251228";
export declare const BYTEPLUS_CODING_DEFAULT_MODEL_ID = "ark-code-latest";
export declare const BYTEPLUS_DEFAULT_MODEL_REF = "byteplus/seed-1-8-251228";
export declare const BYTEPLUS_DEFAULT_COST: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};
/**
 * Complete catalog of BytePlus ARK models.
 *
 * BytePlus ARK provides access to various models
 * through the ARK API. Authentication requires a BYTEPLUS_API_KEY.
 */
export declare const BYTEPLUS_MODEL_CATALOG: readonly [{
    readonly id: "seed-1-8-251228";
    readonly name: "Seed 1.8";
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
}];
export type BytePlusCatalogEntry = (typeof BYTEPLUS_MODEL_CATALOG)[number];
export type BytePlusCodingCatalogEntry = (typeof BYTEPLUS_CODING_MODEL_CATALOG)[number];
export declare function buildBytePlusModelDefinition(entry: BytePlusCatalogEntry | BytePlusCodingCatalogEntry): ModelDefinitionConfig;
export declare const BYTEPLUS_CODING_MODEL_CATALOG: readonly [{
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
}];
