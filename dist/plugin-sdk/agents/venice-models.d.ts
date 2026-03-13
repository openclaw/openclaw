import type { ModelDefinitionConfig } from "../config/types.js";
export declare const VENICE_BASE_URL = "https://api.venice.ai/api/v1";
export declare const VENICE_DEFAULT_MODEL_ID = "kimi-k2-5";
export declare const VENICE_DEFAULT_MODEL_REF = "venice/kimi-k2-5";
export declare const VENICE_DEFAULT_COST: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
};
/**
 * Complete catalog of Venice AI models.
 *
 * Venice provides two privacy modes:
 * - "private": Fully private inference, no logging, ephemeral
 * - "anonymized": Proxied through Venice with metadata stripped (for proprietary models)
 *
 * Note: The `privacy` field is included for documentation purposes but is not
 * propagated to ModelDefinitionConfig as it's not part of the core model schema.
 * Privacy mode is determined by the model itself, not configurable at runtime.
 *
 * This catalog serves as a fallback when the Venice API is unreachable.
 */
export declare const VENICE_MODEL_CATALOG: readonly [{
    readonly id: "llama-3.3-70b";
    readonly name: "Llama 3.3 70B";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 4096;
    readonly privacy: "private";
}, {
    readonly id: "llama-3.2-3b";
    readonly name: "Llama 3.2 3B";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 4096;
    readonly privacy: "private";
}, {
    readonly id: "hermes-3-llama-3.1-405b";
    readonly name: "Hermes 3 Llama 3.1 405B";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 16384;
    readonly supportsTools: false;
    readonly privacy: "private";
}, {
    readonly id: "qwen3-235b-a22b-thinking-2507";
    readonly name: "Qwen3 235B Thinking";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 16384;
    readonly privacy: "private";
}, {
    readonly id: "qwen3-235b-a22b-instruct-2507";
    readonly name: "Qwen3 235B Instruct";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 16384;
    readonly privacy: "private";
}, {
    readonly id: "qwen3-coder-480b-a35b-instruct";
    readonly name: "Qwen3 Coder 480B";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 65536;
    readonly privacy: "private";
}, {
    readonly id: "qwen3-coder-480b-a35b-instruct-turbo";
    readonly name: "Qwen3 Coder 480B Turbo";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 65536;
    readonly privacy: "private";
}, {
    readonly id: "qwen3-5-35b-a3b";
    readonly name: "Qwen3.5 35B A3B";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 256000;
    readonly maxTokens: 65536;
    readonly privacy: "private";
}, {
    readonly id: "qwen3-next-80b";
    readonly name: "Qwen3 Next 80B";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 16384;
    readonly privacy: "private";
}, {
    readonly id: "qwen3-vl-235b-a22b";
    readonly name: "Qwen3 VL 235B (Vision)";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 256000;
    readonly maxTokens: 16384;
    readonly privacy: "private";
}, {
    readonly id: "qwen3-4b";
    readonly name: "Venice Small (Qwen3 4B)";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 32000;
    readonly maxTokens: 4096;
    readonly privacy: "private";
}, {
    readonly id: "deepseek-v3.2";
    readonly name: "DeepSeek V3.2";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 160000;
    readonly maxTokens: 32768;
    readonly supportsTools: false;
    readonly privacy: "private";
}, {
    readonly id: "venice-uncensored";
    readonly name: "Venice Uncensored (Dolphin-Mistral)";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 32000;
    readonly maxTokens: 4096;
    readonly supportsTools: false;
    readonly privacy: "private";
}, {
    readonly id: "mistral-31-24b";
    readonly name: "Venice Medium (Mistral)";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 128000;
    readonly maxTokens: 4096;
    readonly privacy: "private";
}, {
    readonly id: "google-gemma-3-27b-it";
    readonly name: "Google Gemma 3 27B Instruct";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 198000;
    readonly maxTokens: 16384;
    readonly privacy: "private";
}, {
    readonly id: "openai-gpt-oss-120b";
    readonly name: "OpenAI GPT OSS 120B";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 16384;
    readonly privacy: "private";
}, {
    readonly id: "nvidia-nemotron-3-nano-30b-a3b";
    readonly name: "NVIDIA Nemotron 3 Nano 30B";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 16384;
    readonly privacy: "private";
}, {
    readonly id: "olafangensan-glm-4.7-flash-heretic";
    readonly name: "GLM 4.7 Flash Heretic";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 24000;
    readonly privacy: "private";
}, {
    readonly id: "zai-org-glm-4.6";
    readonly name: "GLM 4.6";
    readonly reasoning: false;
    readonly input: readonly ["text"];
    readonly contextWindow: 198000;
    readonly maxTokens: 16384;
    readonly privacy: "private";
}, {
    readonly id: "zai-org-glm-4.7";
    readonly name: "GLM 4.7";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 198000;
    readonly maxTokens: 16384;
    readonly privacy: "private";
}, {
    readonly id: "zai-org-glm-4.7-flash";
    readonly name: "GLM 4.7 Flash";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 128000;
    readonly maxTokens: 16384;
    readonly privacy: "private";
}, {
    readonly id: "zai-org-glm-5";
    readonly name: "GLM 5";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 198000;
    readonly maxTokens: 32000;
    readonly privacy: "private";
}, {
    readonly id: "kimi-k2-5";
    readonly name: "Kimi K2.5";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 256000;
    readonly maxTokens: 65536;
    readonly privacy: "private";
}, {
    readonly id: "kimi-k2-thinking";
    readonly name: "Kimi K2 Thinking";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 65536;
    readonly privacy: "private";
}, {
    readonly id: "minimax-m21";
    readonly name: "MiniMax M2.1";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 198000;
    readonly maxTokens: 32768;
    readonly privacy: "private";
}, {
    readonly id: "minimax-m25";
    readonly name: "MiniMax M2.5";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 198000;
    readonly maxTokens: 32768;
    readonly privacy: "private";
}, {
    readonly id: "claude-opus-4-5";
    readonly name: "Claude Opus 4.5 (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 198000;
    readonly maxTokens: 32768;
    readonly privacy: "anonymized";
}, {
    readonly id: "claude-opus-4-6";
    readonly name: "Claude Opus 4.6 (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 1000000;
    readonly maxTokens: 128000;
    readonly privacy: "anonymized";
}, {
    readonly id: "claude-sonnet-4-5";
    readonly name: "Claude Sonnet 4.5 (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 198000;
    readonly maxTokens: 64000;
    readonly privacy: "anonymized";
}, {
    readonly id: "claude-sonnet-4-6";
    readonly name: "Claude Sonnet 4.6 (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 1000000;
    readonly maxTokens: 64000;
    readonly privacy: "anonymized";
}, {
    readonly id: "openai-gpt-52";
    readonly name: "GPT-5.2 (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 65536;
    readonly privacy: "anonymized";
}, {
    readonly id: "openai-gpt-52-codex";
    readonly name: "GPT-5.2 Codex (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 256000;
    readonly maxTokens: 65536;
    readonly privacy: "anonymized";
}, {
    readonly id: "openai-gpt-53-codex";
    readonly name: "GPT-5.3 Codex (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 400000;
    readonly maxTokens: 128000;
    readonly privacy: "anonymized";
}, {
    readonly id: "openai-gpt-54";
    readonly name: "GPT-5.4 (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 1000000;
    readonly maxTokens: 131072;
    readonly privacy: "anonymized";
}, {
    readonly id: "openai-gpt-4o-2024-11-20";
    readonly name: "GPT-4o (via Venice)";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 128000;
    readonly maxTokens: 16384;
    readonly privacy: "anonymized";
}, {
    readonly id: "openai-gpt-4o-mini-2024-07-18";
    readonly name: "GPT-4o Mini (via Venice)";
    readonly reasoning: false;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 128000;
    readonly maxTokens: 16384;
    readonly privacy: "anonymized";
}, {
    readonly id: "gemini-3-pro-preview";
    readonly name: "Gemini 3 Pro (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 198000;
    readonly maxTokens: 32768;
    readonly privacy: "anonymized";
}, {
    readonly id: "gemini-3-1-pro-preview";
    readonly name: "Gemini 3.1 Pro (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 1000000;
    readonly maxTokens: 32768;
    readonly privacy: "anonymized";
}, {
    readonly id: "gemini-3-flash-preview";
    readonly name: "Gemini 3 Flash (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 256000;
    readonly maxTokens: 65536;
    readonly privacy: "anonymized";
}, {
    readonly id: "grok-41-fast";
    readonly name: "Grok 4.1 Fast (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text", "image"];
    readonly contextWindow: 1000000;
    readonly maxTokens: 30000;
    readonly privacy: "anonymized";
}, {
    readonly id: "grok-code-fast-1";
    readonly name: "Grok Code Fast 1 (via Venice)";
    readonly reasoning: true;
    readonly input: readonly ["text"];
    readonly contextWindow: 256000;
    readonly maxTokens: 10000;
    readonly privacy: "anonymized";
}];
export type VeniceCatalogEntry = (typeof VENICE_MODEL_CATALOG)[number];
/**
 * Build a ModelDefinitionConfig from a Venice catalog entry.
 *
 * Note: The `privacy` field from the catalog is not included in the output
 * as ModelDefinitionConfig doesn't support custom metadata fields. Privacy
 * mode is inherent to each model and documented in the catalog/docs.
 */
export declare function buildVeniceModelDefinition(entry: VeniceCatalogEntry): ModelDefinitionConfig;
/**
 * Discover models from Venice API with fallback to static catalog.
 * The /models endpoint is public and doesn't require authentication.
 */
export declare function discoverVeniceModels(): Promise<ModelDefinitionConfig[]>;
