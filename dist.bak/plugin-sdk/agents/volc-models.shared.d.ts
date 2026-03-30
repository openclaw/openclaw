import type { ModelDefinitionConfig } from "../config/types.js";
export type VolcModelCatalogEntry = {
    id: string;
    name: string;
    reasoning: boolean;
    input: ReadonlyArray<ModelDefinitionConfig["input"][number]>;
    contextWindow: number;
    maxTokens: number;
};
export declare const VOLC_MODEL_KIMI_K2_5: {
    readonly id: "kimi-k2-5-260127";
    readonly name: "Kimi K2.5";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 256000;
    readonly maxTokens: 4096;
};
export declare const VOLC_MODEL_GLM_4_7: {
    readonly id: "glm-4-7-251222";
    readonly name: "GLM 4.7";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 200000;
    readonly maxTokens: 4096;
};
export declare const VOLC_SHARED_CODING_MODEL_CATALOG: readonly [{
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
export declare function buildVolcModelDefinition(entry: VolcModelCatalogEntry, cost: ModelDefinitionConfig["cost"]): ModelDefinitionConfig;
