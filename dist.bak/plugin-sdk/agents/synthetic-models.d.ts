import type { ModelDefinitionConfig } from "../config/types.js";
export declare const SYNTHETIC_BASE_URL = "https://api.synthetic.new/anthropic";
export declare const SYNTHETIC_DEFAULT_MODEL_ID = "hf:MiniMaxAI/MiniMax-M2.1";
export declare const SYNTHETIC_DEFAULT_MODEL_REF = "synthetic/hf:MiniMaxAI/MiniMax-M2.1";
export declare const SYNTHETIC_DEFAULT_COST: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};
export declare const SYNTHETIC_MODEL_CATALOG: readonly [{
    readonly id: "hf:MiniMaxAI/MiniMax-M2.1";
    readonly name: "MiniMax M2.1";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 192000;
    readonly maxTokens: 65536;
}, {
    readonly id: "hf:moonshotai/Kimi-K2-Thinking";
    readonly name: "Kimi K2 Thinking";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:zai-org/GLM-4.7";
    readonly name: "GLM-4.7";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 198000;
    readonly maxTokens: 128000;
}, {
    readonly id: "hf:deepseek-ai/DeepSeek-R1-0528";
    readonly name: "DeepSeek R1 0528";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:deepseek-ai/DeepSeek-V3-0324";
    readonly name: "DeepSeek V3 0324";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:deepseek-ai/DeepSeek-V3.1";
    readonly name: "DeepSeek V3.1";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:deepseek-ai/DeepSeek-V3.1-Terminus";
    readonly name: "DeepSeek V3.1 Terminus";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:deepseek-ai/DeepSeek-V3.2";
    readonly name: "DeepSeek V3.2";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 159000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:meta-llama/Llama-3.3-70B-Instruct";
    readonly name: "Llama 3.3 70B Instruct";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8";
    readonly name: "Llama 4 Maverick 17B 128E Instruct FP8";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 524000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:moonshotai/Kimi-K2-Instruct-0905";
    readonly name: "Kimi K2 Instruct 0905";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:moonshotai/Kimi-K2.5";
    readonly name: "Kimi K2.5";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 256000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:openai/gpt-oss-120b";
    readonly name: "GPT OSS 120B";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:Qwen/Qwen3-235B-A22B-Instruct-2507";
    readonly name: "Qwen3 235B A22B Instruct 2507";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:Qwen/Qwen3-Coder-480B-A35B-Instruct";
    readonly name: "Qwen3 Coder 480B A35B Instruct";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:Qwen/Qwen3-VL-235B-A22B-Instruct";
    readonly name: "Qwen3 VL 235B A22B Instruct";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 250000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:zai-org/GLM-4.5";
    readonly name: "GLM-4.5";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 128000;
}, {
    readonly id: "hf:zai-org/GLM-4.6";
    readonly name: "GLM-4.6";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 198000;
    readonly maxTokens: 128000;
}, {
    readonly id: "hf:zai-org/GLM-5";
    readonly name: "GLM-5";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 256000;
    readonly maxTokens: 128000;
}, {
    readonly id: "hf:deepseek-ai/DeepSeek-V3";
    readonly name: "DeepSeek V3";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 8192;
}, {
    readonly id: "hf:Qwen/Qwen3-235B-A22B-Thinking-2507";
    readonly name: "Qwen3 235B A22B Thinking 2507";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 8192;
}];
export type SyntheticCatalogEntry = (typeof SYNTHETIC_MODEL_CATALOG)[number];
export declare function buildSyntheticModelDefinition(entry: SyntheticCatalogEntry): ModelDefinitionConfig;
