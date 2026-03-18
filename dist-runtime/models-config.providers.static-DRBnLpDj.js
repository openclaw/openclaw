import { o as KILOCODE_MODEL_CATALOG, r as KILOCODE_DEFAULT_COST, t as KILOCODE_BASE_URL } from "./kilocode-shared-Ci8SRxXc.js";
//#region src/agents/volc-models.shared.ts
const VOLC_MODEL_KIMI_K2_5 = {
	id: "kimi-k2-5-260127",
	name: "Kimi K2.5",
	reasoning: false,
	input: ["text", "image"],
	contextWindow: 256e3,
	maxTokens: 4096
};
const VOLC_MODEL_GLM_4_7 = {
	id: "glm-4-7-251222",
	name: "GLM 4.7",
	reasoning: false,
	input: ["text", "image"],
	contextWindow: 2e5,
	maxTokens: 4096
};
const VOLC_SHARED_CODING_MODEL_CATALOG = [
	{
		id: "ark-code-latest",
		name: "Ark Coding Plan",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	{
		id: "doubao-seed-code",
		name: "Doubao Seed Code",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	{
		id: "glm-4.7",
		name: "GLM 4.7 Coding",
		reasoning: false,
		input: ["text"],
		contextWindow: 2e5,
		maxTokens: 4096
	},
	{
		id: "kimi-k2-thinking",
		name: "Kimi K2 Thinking",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	{
		id: "kimi-k2.5",
		name: "Kimi K2.5 Coding",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 4096
	}
];
function buildVolcModelDefinition(entry, cost) {
	return {
		id: entry.id,
		name: entry.name,
		reasoning: entry.reasoning,
		input: [...entry.input],
		cost,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens
	};
}
//#endregion
//#region src/agents/byteplus-models.ts
const BYTEPLUS_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/v3";
const BYTEPLUS_CODING_BASE_URL = "https://ark.ap-southeast.bytepluses.com/api/coding/v3";
const BYTEPLUS_DEFAULT_COST = {
	input: 1e-4,
	output: 2e-4,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* Complete catalog of BytePlus ARK models.
*
* BytePlus ARK provides access to various models
* through the ARK API. Authentication requires a BYTEPLUS_API_KEY.
*/
const BYTEPLUS_MODEL_CATALOG = [
	{
		id: "seed-1-8-251228",
		name: "Seed 1.8",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	VOLC_MODEL_KIMI_K2_5,
	VOLC_MODEL_GLM_4_7
];
function buildBytePlusModelDefinition(entry) {
	return buildVolcModelDefinition(entry, BYTEPLUS_DEFAULT_COST);
}
const BYTEPLUS_CODING_MODEL_CATALOG = VOLC_SHARED_CODING_MODEL_CATALOG;
//#endregion
//#region src/agents/doubao-models.ts
const DOUBAO_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
const DOUBAO_CODING_BASE_URL = "https://ark.cn-beijing.volces.com/api/coding/v3";
const DOUBAO_DEFAULT_COST = {
	input: 1e-4,
	output: 2e-4,
	cacheRead: 0,
	cacheWrite: 0
};
/**
* Complete catalog of Volcano Engine models.
*
* Volcano Engine provides access to models
* through the API. Authentication requires a Volcano Engine API Key.
*/
const DOUBAO_MODEL_CATALOG = [
	{
		id: "doubao-seed-code-preview-251028",
		name: "doubao-seed-code-preview-251028",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	{
		id: "doubao-seed-1-8-251228",
		name: "Doubao Seed 1.8",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 4096
	},
	VOLC_MODEL_KIMI_K2_5,
	VOLC_MODEL_GLM_4_7,
	{
		id: "deepseek-v3-2-251201",
		name: "DeepSeek V3.2",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 128e3,
		maxTokens: 4096
	}
];
function buildDoubaoModelDefinition(entry) {
	return buildVolcModelDefinition(entry, DOUBAO_DEFAULT_COST);
}
const DOUBAO_CODING_MODEL_CATALOG = [...VOLC_SHARED_CODING_MODEL_CATALOG, {
	id: "doubao-seed-code-preview-251028",
	name: "Doubao Seed Code Preview",
	reasoning: false,
	input: ["text"],
	contextWindow: 256e3,
	maxTokens: 4096
}];
//#endregion
//#region src/agents/synthetic-models.ts
const SYNTHETIC_BASE_URL = "https://api.synthetic.new/anthropic";
const SYNTHETIC_DEFAULT_MODEL_ID = "hf:MiniMaxAI/MiniMax-M2.5";
const SYNTHETIC_DEFAULT_MODEL_REF = `synthetic/${SYNTHETIC_DEFAULT_MODEL_ID}`;
const SYNTHETIC_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const SYNTHETIC_MODEL_CATALOG = [
	{
		id: SYNTHETIC_DEFAULT_MODEL_ID,
		name: "MiniMax M2.5",
		reasoning: false,
		input: ["text"],
		contextWindow: 192e3,
		maxTokens: 65536
	},
	{
		id: "hf:moonshotai/Kimi-K2-Thinking",
		name: "Kimi K2 Thinking",
		reasoning: true,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 8192
	},
	{
		id: "hf:zai-org/GLM-4.7",
		name: "GLM-4.7",
		reasoning: false,
		input: ["text"],
		contextWindow: 198e3,
		maxTokens: 128e3
	},
	{
		id: "hf:deepseek-ai/DeepSeek-R1-0528",
		name: "DeepSeek R1 0528",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:deepseek-ai/DeepSeek-V3-0324",
		name: "DeepSeek V3 0324",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:deepseek-ai/DeepSeek-V3.1",
		name: "DeepSeek V3.1",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:deepseek-ai/DeepSeek-V3.1-Terminus",
		name: "DeepSeek V3.1 Terminus",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:deepseek-ai/DeepSeek-V3.2",
		name: "DeepSeek V3.2",
		reasoning: false,
		input: ["text"],
		contextWindow: 159e3,
		maxTokens: 8192
	},
	{
		id: "hf:meta-llama/Llama-3.3-70B-Instruct",
		name: "Llama 3.3 70B Instruct",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
		name: "Llama 4 Maverick 17B 128E Instruct FP8",
		reasoning: false,
		input: ["text"],
		contextWindow: 524e3,
		maxTokens: 8192
	},
	{
		id: "hf:moonshotai/Kimi-K2-Instruct-0905",
		name: "Kimi K2 Instruct 0905",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 8192
	},
	{
		id: "hf:moonshotai/Kimi-K2.5",
		name: "Kimi K2.5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 8192
	},
	{
		id: "hf:openai/gpt-oss-120b",
		name: "GPT OSS 120B",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:Qwen/Qwen3-235B-A22B-Instruct-2507",
		name: "Qwen3 235B A22B Instruct 2507",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 8192
	},
	{
		id: "hf:Qwen/Qwen3-Coder-480B-A35B-Instruct",
		name: "Qwen3 Coder 480B A35B Instruct",
		reasoning: false,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 8192
	},
	{
		id: "hf:Qwen/Qwen3-VL-235B-A22B-Instruct",
		name: "Qwen3 VL 235B A22B Instruct",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 25e4,
		maxTokens: 8192
	},
	{
		id: "hf:zai-org/GLM-4.5",
		name: "GLM-4.5",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 128e3
	},
	{
		id: "hf:zai-org/GLM-4.6",
		name: "GLM-4.6",
		reasoning: false,
		input: ["text"],
		contextWindow: 198e3,
		maxTokens: 128e3
	},
	{
		id: "hf:zai-org/GLM-5",
		name: "GLM-5",
		reasoning: true,
		input: ["text", "image"],
		contextWindow: 256e3,
		maxTokens: 128e3
	},
	{
		id: "hf:deepseek-ai/DeepSeek-V3",
		name: "DeepSeek V3",
		reasoning: false,
		input: ["text"],
		contextWindow: 128e3,
		maxTokens: 8192
	},
	{
		id: "hf:Qwen/Qwen3-235B-A22B-Thinking-2507",
		name: "Qwen3 235B A22B Thinking 2507",
		reasoning: true,
		input: ["text"],
		contextWindow: 256e3,
		maxTokens: 8192
	}
];
function buildSyntheticModelDefinition(entry) {
	return {
		id: entry.id,
		name: entry.name,
		reasoning: entry.reasoning,
		input: [...entry.input],
		cost: SYNTHETIC_DEFAULT_COST,
		contextWindow: entry.contextWindow,
		maxTokens: entry.maxTokens
	};
}
//#endregion
//#region src/agents/together-models.ts
const TOGETHER_BASE_URL = "https://api.together.xyz/v1";
const TOGETHER_MODEL_CATALOG = [
	{
		id: "zai-org/GLM-4.7",
		name: "GLM 4.7 Fp8",
		reasoning: false,
		input: ["text"],
		contextWindow: 202752,
		maxTokens: 8192,
		cost: {
			input: .45,
			output: 2,
			cacheRead: .45,
			cacheWrite: 2
		}
	},
	{
		id: "moonshotai/Kimi-K2.5",
		name: "Kimi K2.5",
		reasoning: true,
		input: ["text", "image"],
		cost: {
			input: .5,
			output: 2.8,
			cacheRead: .5,
			cacheWrite: 2.8
		},
		contextWindow: 262144,
		maxTokens: 32768
	},
	{
		id: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
		name: "Llama 3.3 70B Instruct Turbo",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: .88,
			output: .88,
			cacheRead: .88,
			cacheWrite: .88
		}
	},
	{
		id: "meta-llama/Llama-4-Scout-17B-16E-Instruct",
		name: "Llama 4 Scout 17B 16E Instruct",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 1e7,
		maxTokens: 32768,
		cost: {
			input: .18,
			output: .59,
			cacheRead: .18,
			cacheWrite: .18
		}
	},
	{
		id: "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8",
		name: "Llama 4 Maverick 17B 128E Instruct FP8",
		reasoning: false,
		input: ["text", "image"],
		contextWindow: 2e7,
		maxTokens: 32768,
		cost: {
			input: .27,
			output: .85,
			cacheRead: .27,
			cacheWrite: .27
		}
	},
	{
		id: "deepseek-ai/DeepSeek-V3.1",
		name: "DeepSeek V3.1",
		reasoning: false,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: .6,
			output: 1.25,
			cacheRead: .6,
			cacheWrite: .6
		}
	},
	{
		id: "deepseek-ai/DeepSeek-R1",
		name: "DeepSeek R1",
		reasoning: true,
		input: ["text"],
		contextWindow: 131072,
		maxTokens: 8192,
		cost: {
			input: 3,
			output: 7,
			cacheRead: 3,
			cacheWrite: 3
		}
	},
	{
		id: "moonshotai/Kimi-K2-Instruct-0905",
		name: "Kimi K2-Instruct 0905",
		reasoning: false,
		input: ["text"],
		contextWindow: 262144,
		maxTokens: 8192,
		cost: {
			input: 1,
			output: 3,
			cacheRead: 1,
			cacheWrite: 3
		}
	}
];
function buildTogetherModelDefinition(model) {
	return {
		id: model.id,
		name: model.name,
		api: "openai-completions",
		reasoning: model.reasoning,
		input: model.input,
		cost: model.cost,
		contextWindow: model.contextWindow,
		maxTokens: model.maxTokens
	};
}
//#endregion
//#region src/agents/models-config.providers.static.ts
const MINIMAX_PORTAL_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.5";
const MINIMAX_DEFAULT_VISION_MODEL_ID = "MiniMax-VL-01";
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 2e5;
const MINIMAX_DEFAULT_MAX_TOKENS = 8192;
const MINIMAX_API_COST = {
	input: .3,
	output: 1.2,
	cacheRead: .03,
	cacheWrite: .12
};
function buildMinimaxModel(params) {
	return {
		id: params.id,
		name: params.name,
		reasoning: params.reasoning,
		input: params.input,
		cost: MINIMAX_API_COST,
		contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
		maxTokens: MINIMAX_DEFAULT_MAX_TOKENS
	};
}
function buildMinimaxTextModel(params) {
	return buildMinimaxModel({
		...params,
		input: ["text"]
	});
}
const XIAOMI_BASE_URL = "https://api.xiaomimimo.com/anthropic";
const XIAOMI_DEFAULT_MODEL_ID = "mimo-v2-flash";
const XIAOMI_DEFAULT_CONTEXT_WINDOW = 262144;
const XIAOMI_DEFAULT_MAX_TOKENS = 8192;
const XIAOMI_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.5";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256e3;
const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
const MOONSHOT_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const KIMI_CODING_BASE_URL = "https://api.kimi.com/coding/";
const KIMI_CODING_USER_AGENT = "claude-code/0.1.0";
const KIMI_CODING_DEFAULT_MODEL_ID = "k2p5";
const KIMI_CODING_DEFAULT_CONTEXT_WINDOW = 262144;
const KIMI_CODING_DEFAULT_MAX_TOKENS = 32768;
const KIMI_CODING_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MODEL_ID = "auto";
const OPENROUTER_DEFAULT_CONTEXT_WINDOW = 2e5;
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";
const QIANFAN_DEFAULT_MODEL_ID = "deepseek-v3.2";
const QIANFAN_DEFAULT_CONTEXT_WINDOW = 98304;
const QIANFAN_DEFAULT_MAX_TOKENS = 32768;
const QIANFAN_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const MODELSTUDIO_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
const MODELSTUDIO_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const MODELSTUDIO_MODEL_CATALOG = [
	{
		id: "qwen3.5-plus",
		name: "qwen3.5-plus",
		reasoning: false,
		input: ["text", "image"],
		cost: MODELSTUDIO_DEFAULT_COST,
		contextWindow: 1e6,
		maxTokens: 65536
	},
	{
		id: "qwen3-max-2026-01-23",
		name: "qwen3-max-2026-01-23",
		reasoning: false,
		input: ["text"],
		cost: MODELSTUDIO_DEFAULT_COST,
		contextWindow: 262144,
		maxTokens: 65536
	},
	{
		id: "qwen3-coder-next",
		name: "qwen3-coder-next",
		reasoning: false,
		input: ["text"],
		cost: MODELSTUDIO_DEFAULT_COST,
		contextWindow: 262144,
		maxTokens: 65536
	},
	{
		id: "qwen3-coder-plus",
		name: "qwen3-coder-plus",
		reasoning: false,
		input: ["text"],
		cost: MODELSTUDIO_DEFAULT_COST,
		contextWindow: 1e6,
		maxTokens: 65536
	},
	{
		id: "MiniMax-M2.5",
		name: "MiniMax-M2.5",
		reasoning: true,
		input: ["text"],
		cost: MODELSTUDIO_DEFAULT_COST,
		contextWindow: 1e6,
		maxTokens: 65536
	},
	{
		id: "glm-5",
		name: "glm-5",
		reasoning: false,
		input: ["text"],
		cost: MODELSTUDIO_DEFAULT_COST,
		contextWindow: 202752,
		maxTokens: 16384
	},
	{
		id: "glm-4.7",
		name: "glm-4.7",
		reasoning: false,
		input: ["text"],
		cost: MODELSTUDIO_DEFAULT_COST,
		contextWindow: 202752,
		maxTokens: 16384
	},
	{
		id: "kimi-k2.5",
		name: "kimi-k2.5",
		reasoning: false,
		input: ["text", "image"],
		cost: MODELSTUDIO_DEFAULT_COST,
		contextWindow: 262144,
		maxTokens: 32768
	}
];
const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";
const NVIDIA_DEFAULT_MODEL_ID = "nvidia/llama-3.1-nemotron-70b-instruct";
const NVIDIA_DEFAULT_CONTEXT_WINDOW = 131072;
const NVIDIA_DEFAULT_MAX_TOKENS = 4096;
const NVIDIA_DEFAULT_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0
};
const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";
function buildMinimaxProvider() {
	return {
		baseUrl: MINIMAX_PORTAL_BASE_URL,
		api: "anthropic-messages",
		authHeader: true,
		models: [
			buildMinimaxModel({
				id: MINIMAX_DEFAULT_VISION_MODEL_ID,
				name: "MiniMax VL 01",
				reasoning: false,
				input: ["text", "image"]
			}),
			buildMinimaxTextModel({
				id: "MiniMax-M2.5",
				name: "MiniMax M2.5",
				reasoning: true
			}),
			buildMinimaxTextModel({
				id: "MiniMax-M2.5-highspeed",
				name: "MiniMax M2.5 Highspeed",
				reasoning: true
			})
		]
	};
}
function buildMinimaxPortalProvider() {
	return {
		baseUrl: MINIMAX_PORTAL_BASE_URL,
		api: "anthropic-messages",
		authHeader: true,
		models: [
			buildMinimaxModel({
				id: MINIMAX_DEFAULT_VISION_MODEL_ID,
				name: "MiniMax VL 01",
				reasoning: false,
				input: ["text", "image"]
			}),
			buildMinimaxTextModel({
				id: MINIMAX_DEFAULT_MODEL_ID,
				name: "MiniMax M2.5",
				reasoning: true
			}),
			buildMinimaxTextModel({
				id: "MiniMax-M2.5-highspeed",
				name: "MiniMax M2.5 Highspeed",
				reasoning: true
			})
		]
	};
}
function buildMoonshotProvider() {
	return {
		baseUrl: MOONSHOT_BASE_URL,
		api: "openai-completions",
		models: [{
			id: MOONSHOT_DEFAULT_MODEL_ID,
			name: "Kimi K2.5",
			reasoning: false,
			input: ["text", "image"],
			cost: MOONSHOT_DEFAULT_COST,
			contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
			maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS
		}]
	};
}
function buildKimiCodingProvider() {
	return {
		baseUrl: KIMI_CODING_BASE_URL,
		api: "anthropic-messages",
		headers: { "User-Agent": KIMI_CODING_USER_AGENT },
		models: [{
			id: KIMI_CODING_DEFAULT_MODEL_ID,
			name: "Kimi for Coding",
			reasoning: true,
			input: ["text", "image"],
			cost: KIMI_CODING_DEFAULT_COST,
			contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
			maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS
		}]
	};
}
function buildSyntheticProvider() {
	return {
		baseUrl: SYNTHETIC_BASE_URL,
		api: "anthropic-messages",
		models: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition)
	};
}
function buildDoubaoProvider() {
	return {
		baseUrl: DOUBAO_BASE_URL,
		api: "openai-completions",
		models: DOUBAO_MODEL_CATALOG.map(buildDoubaoModelDefinition)
	};
}
function buildDoubaoCodingProvider() {
	return {
		baseUrl: DOUBAO_CODING_BASE_URL,
		api: "openai-completions",
		models: DOUBAO_CODING_MODEL_CATALOG.map(buildDoubaoModelDefinition)
	};
}
function buildBytePlusProvider() {
	return {
		baseUrl: BYTEPLUS_BASE_URL,
		api: "openai-completions",
		models: BYTEPLUS_MODEL_CATALOG.map(buildBytePlusModelDefinition)
	};
}
function buildBytePlusCodingProvider() {
	return {
		baseUrl: BYTEPLUS_CODING_BASE_URL,
		api: "openai-completions",
		models: BYTEPLUS_CODING_MODEL_CATALOG.map(buildBytePlusModelDefinition)
	};
}
function buildXiaomiProvider() {
	return {
		baseUrl: XIAOMI_BASE_URL,
		api: "anthropic-messages",
		models: [{
			id: XIAOMI_DEFAULT_MODEL_ID,
			name: "Xiaomi MiMo V2 Flash",
			reasoning: false,
			input: ["text"],
			cost: XIAOMI_DEFAULT_COST,
			contextWindow: XIAOMI_DEFAULT_CONTEXT_WINDOW,
			maxTokens: XIAOMI_DEFAULT_MAX_TOKENS
		}]
	};
}
function buildTogetherProvider() {
	return {
		baseUrl: TOGETHER_BASE_URL,
		api: "openai-completions",
		models: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition)
	};
}
function buildOpenrouterProvider() {
	return {
		baseUrl: OPENROUTER_BASE_URL,
		api: "openai-completions",
		models: [
			{
				id: OPENROUTER_DEFAULT_MODEL_ID,
				name: "OpenRouter Auto",
				reasoning: false,
				input: ["text", "image"],
				cost: OPENROUTER_DEFAULT_COST,
				contextWindow: OPENROUTER_DEFAULT_CONTEXT_WINDOW,
				maxTokens: OPENROUTER_DEFAULT_MAX_TOKENS
			},
			{
				id: "openrouter/hunter-alpha",
				name: "Hunter Alpha",
				reasoning: true,
				input: ["text"],
				cost: OPENROUTER_DEFAULT_COST,
				contextWindow: 1048576,
				maxTokens: 65536
			},
			{
				id: "openrouter/healer-alpha",
				name: "Healer Alpha",
				reasoning: true,
				input: ["text", "image"],
				cost: OPENROUTER_DEFAULT_COST,
				contextWindow: 262144,
				maxTokens: 65536
			}
		]
	};
}
function buildOpenAICodexProvider() {
	return {
		baseUrl: OPENAI_CODEX_BASE_URL,
		api: "openai-codex-responses",
		models: []
	};
}
function buildQianfanProvider() {
	return {
		baseUrl: QIANFAN_BASE_URL,
		api: "openai-completions",
		models: [{
			id: QIANFAN_DEFAULT_MODEL_ID,
			name: "DEEPSEEK V3.2",
			reasoning: true,
			input: ["text"],
			cost: QIANFAN_DEFAULT_COST,
			contextWindow: QIANFAN_DEFAULT_CONTEXT_WINDOW,
			maxTokens: QIANFAN_DEFAULT_MAX_TOKENS
		}, {
			id: "ernie-5.0-thinking-preview",
			name: "ERNIE-5.0-Thinking-Preview",
			reasoning: true,
			input: ["text", "image"],
			cost: QIANFAN_DEFAULT_COST,
			contextWindow: 119e3,
			maxTokens: 64e3
		}]
	};
}
function buildModelStudioProvider() {
	return {
		baseUrl: MODELSTUDIO_BASE_URL,
		api: "openai-completions",
		models: MODELSTUDIO_MODEL_CATALOG.map((model) => ({ ...model }))
	};
}
function buildNvidiaProvider() {
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
				maxTokens: NVIDIA_DEFAULT_MAX_TOKENS
			},
			{
				id: "meta/llama-3.3-70b-instruct",
				name: "Meta Llama 3.3 70B Instruct",
				reasoning: false,
				input: ["text"],
				cost: NVIDIA_DEFAULT_COST,
				contextWindow: 131072,
				maxTokens: 4096
			},
			{
				id: "nvidia/mistral-nemo-minitron-8b-8k-instruct",
				name: "NVIDIA Mistral NeMo Minitron 8B Instruct",
				reasoning: false,
				input: ["text"],
				cost: NVIDIA_DEFAULT_COST,
				contextWindow: 8192,
				maxTokens: 2048
			}
		]
	};
}
function buildKilocodeProvider() {
	return {
		baseUrl: KILOCODE_BASE_URL,
		api: "openai-completions",
		models: KILOCODE_MODEL_CATALOG.map((model) => ({
			id: model.id,
			name: model.name,
			reasoning: model.reasoning,
			input: model.input,
			cost: KILOCODE_DEFAULT_COST,
			contextWindow: model.contextWindow ?? 1e6,
			maxTokens: model.maxTokens ?? 128e3
		}))
	};
}
//#endregion
export { buildTogetherModelDefinition as C, buildSyntheticModelDefinition as D, SYNTHETIC_MODEL_CATALOG as E, TOGETHER_MODEL_CATALOG as S, SYNTHETIC_DEFAULT_MODEL_REF as T, buildQianfanProvider as _, buildBytePlusProvider as a, buildXiaomiProvider as b, buildKilocodeProvider as c, buildMinimaxProvider as d, buildModelStudioProvider as f, buildOpenrouterProvider as g, buildOpenAICodexProvider as h, buildBytePlusCodingProvider as i, buildKimiCodingProvider as l, buildNvidiaProvider as m, QIANFAN_DEFAULT_MODEL_ID as n, buildDoubaoCodingProvider as o, buildMoonshotProvider as p, XIAOMI_DEFAULT_MODEL_ID as r, buildDoubaoProvider as s, QIANFAN_BASE_URL as t, buildMinimaxPortalProvider as u, buildSyntheticProvider as v, SYNTHETIC_BASE_URL as w, TOGETHER_BASE_URL as x, buildTogetherProvider as y };
