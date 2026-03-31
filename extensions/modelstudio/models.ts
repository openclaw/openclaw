import type { StreamFn } from "@mariozechner/pi-agent-core";
import { streamSimple } from "@mariozechner/pi-ai";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import { streamWithPayloadPatch } from "openclaw/plugin-sdk/provider-stream";

export const MODELSTUDIO_BASE_URL = "https://coding-intl.dashscope.aliyuncs.com/v1";
export const MODELSTUDIO_GLOBAL_BASE_URL = MODELSTUDIO_BASE_URL;
export const MODELSTUDIO_CN_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
export const MODELSTUDIO_STANDARD_CN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const MODELSTUDIO_STANDARD_GLOBAL_BASE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

export const MODELSTUDIO_DEFAULT_MODEL_ID = "qwen3.5-plus";
export const MODELSTUDIO_DEFAULT_COST = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
};
export const MODELSTUDIO_DEFAULT_MODEL_REF = `modelstudio/${MODELSTUDIO_DEFAULT_MODEL_ID}`;

export const MODELSTUDIO_MODEL_CATALOG: ReadonlyArray<ModelDefinitionConfig> = [
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

function normalizeModelStudioBaseUrl(baseUrl: string | undefined): string {
  const trimmed = baseUrl?.trim();
  if (!trimmed) {
    return "";
  }
  try {
    const url = new URL(trimmed);
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return trimmed.replace(/\/+$/, "").toLowerCase();
  }
}

export function isNativeModelStudioBaseUrl(baseUrl: string | undefined): boolean {
  const normalized = normalizeModelStudioBaseUrl(baseUrl);
  return (
    normalized === MODELSTUDIO_BASE_URL ||
    normalized === MODELSTUDIO_CN_BASE_URL ||
    normalized === MODELSTUDIO_STANDARD_CN_BASE_URL ||
    normalized === MODELSTUDIO_STANDARD_GLOBAL_BASE_URL
  );
}

function withStreamingUsageCompat(provider: ModelProviderConfig): ModelProviderConfig {
  if (!Array.isArray(provider.models) || provider.models.length === 0) {
    return provider;
  }

  let changed = false;
  const models = provider.models.map((model) => {
    if (model.compat?.supportsUsageInStreaming !== undefined) {
      return model;
    }
    changed = true;
    return {
      ...model,
      compat: {
        ...model.compat,
        supportsUsageInStreaming: true,
      },
    };
  });

  return changed ? { ...provider, models } : provider;
}

export function applyModelStudioNativeStreamingUsageCompat(
  provider: ModelProviderConfig,
): ModelProviderConfig {
  return isNativeModelStudioBaseUrl(provider.baseUrl)
    ? withStreamingUsageCompat(provider)
    : provider;
}

/**
 * Creates a stream wrapper that adds `stream_options.include_usage=true` to the
 * request payload for Alibaba Cloud DashScope API calls.
 *
 * According to DashScope documentation, streaming responses do not include token
 * usage information by default. Setting `stream_options.include_usage=true` ensures
 * the final chunk contains the token consumption data.
 *
 * @see https://help.aliyun.com/zh/model-studio/stream
 */
export function createDashscopeStreamingUsageWrapper(baseStreamFn: StreamFn | undefined): StreamFn {
  const underlying = baseStreamFn ?? streamSimple;
  return (model, context, options) => {
    // Only apply to OpenAI-compatible completion APIs (dashscope uses this format)
    if (model.api !== "openai-completions") {
      return underlying(model, context, options);
    }

    return streamWithPayloadPatch(underlying, model, context, options, (payloadObj) => {
      // Only add if not already set (respect explicit user configuration)
      if (payloadObj.stream_options === undefined) {
        payloadObj.stream_options = { include_usage: true };
      } else if (
        payloadObj.stream_options &&
        typeof payloadObj.stream_options === "object" &&
        !("include_usage" in payloadObj.stream_options)
      ) {
        (payloadObj.stream_options as Record<string, unknown>).include_usage = true;
      }
    });
  };
}

export function buildModelStudioModelDefinition(params: {
  id: string;
  name?: string;
  reasoning?: boolean;
  input?: string[];
  cost?: ModelDefinitionConfig["cost"];
  contextWindow?: number;
  maxTokens?: number;
}): ModelDefinitionConfig {
  const catalog = MODELSTUDIO_MODEL_CATALOG.find((model) => model.id === params.id);
  return {
    id: params.id,
    name: params.name ?? catalog?.name ?? params.id,
    reasoning: params.reasoning ?? catalog?.reasoning ?? false,
    input:
      (params.input as ("text" | "image")[]) ?? (catalog?.input ? [...catalog.input] : ["text"]),
    cost: params.cost ?? catalog?.cost ?? MODELSTUDIO_DEFAULT_COST,
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 262_144,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 65_536,
  };
}

export function buildModelStudioDefaultModelDefinition(): ModelDefinitionConfig {
  return buildModelStudioModelDefinition({ id: MODELSTUDIO_DEFAULT_MODEL_ID });
}
