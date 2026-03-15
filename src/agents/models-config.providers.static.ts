import type { OpenClawConfig } from "../config/config.js";
import {
  KILOCODE_BASE_URL,
  KILOCODE_DEFAULT_CONTEXT_WINDOW,
  KILOCODE_DEFAULT_COST,
  KILOCODE_DEFAULT_MAX_TOKENS,
  KILOCODE_MODEL_CATALOG,
} from "../providers/kilocode-shared.js";
import {
  buildBytePlusModelDefinition,
  BYTEPLUS_BASE_URL,
  BYTEPLUS_MODEL_CATALOG,
  BYTEPLUS_CODING_BASE_URL,
  BYTEPLUS_CODING_MODEL_CATALOG,
} from "./byteplus-models.js";
import {
  buildDoubaoModelDefinition,
  DOUBAO_BASE_URL,
  DOUBAO_MODEL_CATALOG,
  DOUBAO_CODING_BASE_URL,
  DOUBAO_CODING_MODEL_CATALOG,
} from "./doubao-models.js";
import {
  buildSyntheticModelDefinition,
  SYNTHETIC_BASE_URL,
  SYNTHETIC_MODEL_CATALOG,
} from "./synthetic-models.js";
import {
  TOGETHER_BASE_URL,
  TOGETHER_MODEL_CATALOG,
  buildTogetherModelDefinition,
} from "./together-models.js";

type ModelsConfig = NonNullable<OpenClawConfig["models"]>;
type ProviderConfig = NonNullable<ModelsConfig["providers"]>[string];
type ProviderModelConfig = NonNullable<ProviderConfig["models"]>[number];

const MINIMAX_PORTAL_BASE_URL = "https://api.minimax.io/anthropic";
const MINIMAX_DEFAULT_MODEL_ID = "MiniMax-M2.5";
const MINIMAX_DEFAULT_VISION_MODEL_ID = "MiniMax-VL-01";
const MINIMAX_DEFAULT_CONTEXT_WINDOW = 200000;
const MINIMAX_DEFAULT_MAX_TOKENS = 8192;
const MINIMAX_API_COST = {
  input: 0.3,
  output: 1.2,
  cacheRead: 0.03,
  cacheWrite: 0.12,
};

function buildMinimaxModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  input: ProviderModelConfig["input"];
}): ProviderModelConfig {
  return {
    id: params.id,
    name: params.name,
    reasoning: params.reasoning,
    input: params.input,
    cost: MINIMAX_API_COST,
    contextWindow: MINIMAX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: MINIMAX_DEFAULT_MAX_TOKENS,
  };
}

function buildMinimaxTextModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
}): ProviderModelConfig {
  return buildMinimaxModel({ ...params, input: ["text"] });
}

const XIAOMI_BASE_URL = "https://api.xiaomimimo.com/anthropic";
export const XIAOMI_DEFAULT_MODEL_ID = "mimo-v2-flash";
const XIAOMI_DEFAULT_CONTEXT_WINDOW = 262144;
const XIAOMI_DEFAULT_MAX_TOKENS = 8192;
const XIAOMI_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const MOONSHOT_BASE_URL = "https://api.moonshot.ai/v1";
const MOONSHOT_DEFAULT_MODEL_ID = "kimi-k2.5";
const MOONSHOT_DEFAULT_CONTEXT_WINDOW = 256000;
const MOONSHOT_DEFAULT_MAX_TOKENS = 8192;
const MOONSHOT_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
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
  cacheWrite: 0,
};

const QWEN_PORTAL_BASE_URL = "https://portal.qwen.ai/v1";
const QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW = 128000;
const QWEN_PORTAL_DEFAULT_MAX_TOKENS = 8192;
const QWEN_PORTAL_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
const OPENROUTER_DEFAULT_MODEL_ID = "auto";
const OPENROUTER_DEFAULT_CONTEXT_WINDOW = 200000;
const OPENROUTER_DEFAULT_MAX_TOKENS = 8192;
const OPENROUTER_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const QIANFAN_BASE_URL = "https://qianfan.baidubce.com/v2";
export const QIANFAN_DEFAULT_MODEL_ID = "deepseek-v3.2";
const QIANFAN_DEFAULT_CONTEXT_WINDOW = 98304;
const QIANFAN_DEFAULT_MAX_TOKENS = 32768;
const QIANFAN_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

export const MODELSTUDIO_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
export const MODELSTUDIO_DEFAULT_MODEL_ID = "qwen3.5-plus";
const MODELSTUDIO_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};

const MODELSTUDIO_MODEL_CATALOG: ReadonlyArray<ProviderModelConfig> = [
  {
    id: "qwen3.5-plus",
    name: "qwen3.5-plus",
    reasoning: false,
    input: ["text", "image"],
    cost: MODELSTUDIO_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "qwen3-max-2026-01-23",
    name: "qwen3-max-2026-01-23",
    reasoning: false,
    input: ["text"],
    cost: MODELSTUDIO_DEFAULT_COST,
    contextWindow: 262_144,
    maxTokens: 65_536,
  },
  {
    id: "qwen3-coder-next",
    name: "qwen3-coder-next",
    reasoning: false,
    input: ["text"],
    cost: MODELSTUDIO_DEFAULT_COST,
    contextWindow: 262_144,
    maxTokens: 65_536,
  },
  {
    id: "qwen3-coder-plus",
    name: "qwen3-coder-plus",
    reasoning: false,
    input: ["text"],
    cost: MODELSTUDIO_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "MiniMax-M2.5",
    name: "MiniMax-M2.5",
    reasoning: true,
    input: ["text"],
    cost: MODELSTUDIO_DEFAULT_COST,
    contextWindow: 1_000_000,
    maxTokens: 65_536,
  },
  {
    id: "glm-5",
    name: "glm-5",
    reasoning: false,
    input: ["text"],
    cost: MODELSTUDIO_DEFAULT_COST,
    contextWindow: 202_752,
    maxTokens: 16_384,
  },
  {
    id: "glm-4.7",
    name: "glm-4.7",
    reasoning: false,
    input: ["text"],
    cost: MODELSTUDIO_DEFAULT_COST,
    contextWindow: 202_752,
    maxTokens: 16_384,
  },
  {
    id: "kimi-k2.5",
    name: "kimi-k2.5",
    reasoning: false,
    input: ["text", "image"],
    cost: MODELSTUDIO_DEFAULT_COST,
    contextWindow: 262_144,
    maxTokens: 32_768,
  },
];

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

const OPENAI_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

export function buildMinimaxProvider(): ProviderConfig {
  return {
    baseUrl: MINIMAX_PORTAL_BASE_URL,
    api: "anthropic-messages",
    authHeader: true,
    models: [
      buildMinimaxModel({
        id: MINIMAX_DEFAULT_VISION_MODEL_ID,
        name: "MiniMax VL 01",
        reasoning: false,
        input: ["text", "image"],
      }),
      buildMinimaxTextModel({
        id: "MiniMax-M2.5",
        name: "MiniMax M2.5",
        reasoning: true,
      }),
      buildMinimaxTextModel({
        id: "MiniMax-M2.5-highspeed",
        name: "MiniMax M2.5 Highspeed",
        reasoning: true,
      }),
    ],
  };
}

export function buildMinimaxPortalProvider(): ProviderConfig {
  return {
    baseUrl: MINIMAX_PORTAL_BASE_URL,
    api: "anthropic-messages",
    authHeader: true,
    models: [
      buildMinimaxModel({
        id: MINIMAX_DEFAULT_VISION_MODEL_ID,
        name: "MiniMax VL 01",
        reasoning: false,
        input: ["text", "image"],
      }),
      buildMinimaxTextModel({
        id: MINIMAX_DEFAULT_MODEL_ID,
        name: "MiniMax M2.5",
        reasoning: true,
      }),
      buildMinimaxTextModel({
        id: "MiniMax-M2.5-highspeed",
        name: "MiniMax M2.5 Highspeed",
        reasoning: true,
      }),
    ],
  };
}

export function buildMoonshotProvider(): ProviderConfig {
  return {
    baseUrl: MOONSHOT_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: MOONSHOT_DEFAULT_MODEL_ID,
        name: "Kimi K2.5",
        reasoning: false,
        input: ["text", "image"],
        cost: MOONSHOT_DEFAULT_COST,
        contextWindow: MOONSHOT_DEFAULT_CONTEXT_WINDOW,
        maxTokens: MOONSHOT_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

export function buildKimiCodingProvider(): ProviderConfig {
  return {
    baseUrl: KIMI_CODING_BASE_URL,
    api: "anthropic-messages",
    headers: {
      "User-Agent": KIMI_CODING_USER_AGENT,
    },
    models: [
      {
        id: KIMI_CODING_DEFAULT_MODEL_ID,
        name: "Kimi for Coding",
        reasoning: true,
        input: ["text", "image"],
        cost: KIMI_CODING_DEFAULT_COST,
        contextWindow: KIMI_CODING_DEFAULT_CONTEXT_WINDOW,
        maxTokens: KIMI_CODING_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

export function buildQwenPortalProvider(): ProviderConfig {
  return {
    baseUrl: QWEN_PORTAL_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: "coder-model",
        name: "Qwen Coder",
        reasoning: false,
        input: ["text"],
        cost: QWEN_PORTAL_DEFAULT_COST,
        contextWindow: QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW,
        maxTokens: QWEN_PORTAL_DEFAULT_MAX_TOKENS,
      },
      {
        id: "vision-model",
        name: "Qwen Vision",
        reasoning: false,
        input: ["text", "image"],
        cost: QWEN_PORTAL_DEFAULT_COST,
        contextWindow: QWEN_PORTAL_DEFAULT_CONTEXT_WINDOW,
        maxTokens: QWEN_PORTAL_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

export function buildSyntheticProvider(): ProviderConfig {
  return {
    baseUrl: SYNTHETIC_BASE_URL,
    api: "anthropic-messages",
    models: SYNTHETIC_MODEL_CATALOG.map(buildSyntheticModelDefinition),
  };
}

export function buildDoubaoProvider(): ProviderConfig {
  return {
    baseUrl: DOUBAO_BASE_URL,
    api: "openai-completions",
    models: DOUBAO_MODEL_CATALOG.map(buildDoubaoModelDefinition),
  };
}

export function buildDoubaoCodingProvider(): ProviderConfig {
  return {
    baseUrl: DOUBAO_CODING_BASE_URL,
    api: "openai-completions",
    models: DOUBAO_CODING_MODEL_CATALOG.map(buildDoubaoModelDefinition),
  };
}

export function buildBytePlusProvider(): ProviderConfig {
  return {
    baseUrl: BYTEPLUS_BASE_URL,
    api: "openai-completions",
    models: BYTEPLUS_MODEL_CATALOG.map(buildBytePlusModelDefinition),
  };
}

export function buildBytePlusCodingProvider(): ProviderConfig {
  return {
    baseUrl: BYTEPLUS_CODING_BASE_URL,
    api: "openai-completions",
    models: BYTEPLUS_CODING_MODEL_CATALOG.map(buildBytePlusModelDefinition),
  };
}

export function buildXiaomiProvider(): ProviderConfig {
  return {
    baseUrl: XIAOMI_BASE_URL,
    api: "anthropic-messages",
    models: [
      {
        id: XIAOMI_DEFAULT_MODEL_ID,
        name: "Xiaomi MiMo V2 Flash",
        reasoning: false,
        input: ["text"],
        cost: XIAOMI_DEFAULT_COST,
        contextWindow: XIAOMI_DEFAULT_CONTEXT_WINDOW,
        maxTokens: XIAOMI_DEFAULT_MAX_TOKENS,
      },
    ],
  };
}

export function buildTogetherProvider(): ProviderConfig {
  return {
    baseUrl: TOGETHER_BASE_URL,
    api: "openai-completions",
    models: TOGETHER_MODEL_CATALOG.map(buildTogetherModelDefinition),
  };
}

export function buildOpenrouterProvider(): ProviderConfig {
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
        maxTokens: OPENROUTER_DEFAULT_MAX_TOKENS,
      },
      {
        id: "openrouter/hunter-alpha",
        name: "Hunter Alpha",
        reasoning: true,
        input: ["text"],
        cost: OPENROUTER_DEFAULT_COST,
        contextWindow: 1048576,
        maxTokens: 65536,
      },
      {
        id: "openrouter/healer-alpha",
        name: "Healer Alpha",
        reasoning: true,
        input: ["text", "image"],
        cost: OPENROUTER_DEFAULT_COST,
        contextWindow: 262144,
        maxTokens: 65536,
      },
    ],
  };
}

export function buildOpenAICodexProvider(): ProviderConfig {
  return {
    baseUrl: OPENAI_CODEX_BASE_URL,
    api: "openai-codex-responses",
    models: [],
  };
}

export function buildQianfanProvider(): ProviderConfig {
  return {
    baseUrl: QIANFAN_BASE_URL,
    api: "openai-completions",
    models: [
      {
        id: QIANFAN_DEFAULT_MODEL_ID,
        name: "DEEPSEEK V3.2",
        reasoning: true,
        input: ["text"],
        cost: QIANFAN_DEFAULT_COST,
        contextWindow: QIANFAN_DEFAULT_CONTEXT_WINDOW,
        maxTokens: QIANFAN_DEFAULT_MAX_TOKENS,
      },
      {
        id: "ernie-5.0-thinking-preview",
        name: "ERNIE-5.0-Thinking-Preview",
        reasoning: true,
        input: ["text", "image"],
        cost: QIANFAN_DEFAULT_COST,
        contextWindow: 119000,
        maxTokens: 64000,
      },
    ],
  };
}

export function buildModelStudioProvider(): ProviderConfig {
  return {
    baseUrl: MODELSTUDIO_BASE_URL,
    api: "openai-completions",
    models: MODELSTUDIO_MODEL_CATALOG.map((model) => ({
      ...model,
      compat: { supportsUsageInStreaming: true },
    })),
  };
}

export function buildNvidiaProvider(): ProviderConfig {
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

export function buildKilocodeProvider(): ProviderConfig {
  return {
    baseUrl: KILOCODE_BASE_URL,
    api: "openai-completions",
    models: KILOCODE_MODEL_CATALOG.map((model) => ({
      id: model.id,
      name: model.name,
      reasoning: model.reasoning,
      input: model.input,
      cost: KILOCODE_DEFAULT_COST,
      contextWindow: model.contextWindow ?? KILOCODE_DEFAULT_CONTEXT_WINDOW,
      maxTokens: model.maxTokens ?? KILOCODE_DEFAULT_MAX_TOKENS,
    })),
  };
}
