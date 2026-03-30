import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";

const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_DEFAULT_MODEL_ID = "nvidia/llama-3.1-nemotron-70b-instruct";
const NVIDIA_DEFAULT_CONTEXT_WINDOW = 131072;
const NVIDIA_DEFAULT_MAX_TOKENS = 4096;
const NVIDIA_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

export function buildNvidiaProvider(): ModelProviderConfig {
	return {
		baseUrl: NVIDIA_BASE_URL,
		api: "openai-completions",
		models: [
			{
				id: NVIDIA_DEFAULT_MODEL_ID,
				name: "NVIDIA Llama 3.1 Nemotron 70B Instruct",
				reasoning: false,
				input: ["text"],
				cost: NVIDIA_DEFAULT_COST,
				contextWindow: NVIDIA_DEFAULT_CONTEXT_WINDOW,
				maxTokens: NVIDIA_DEFAULT_MAX_TOKENS,
			},
			{
				id: "meta/llama-3.3-70b-instruct",
				name: "Meta Llama 3.3 70B Instruct",
				reasoning: false,
				input: ["text"],
				cost: NVIDIA_DEFAULT_COST,
				contextWindow: 131072,
				maxTokens: 4096,
			},
			{
				id: "nvidia/mistral-nemo-minitron-8b-8k-instruct",
				name: "NVIDIA Mistral NeMo Minitron 8B Instruct",
				reasoning: false,
				input: ["text"],
				cost: NVIDIA_DEFAULT_COST,
				contextWindow: 8192,
				maxTokens: 2048,
			},
		],
	};
}
