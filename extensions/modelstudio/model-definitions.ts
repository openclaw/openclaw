import type { ModelDefinitionConfig } from "openclaw/plugin-sdk/provider-models";
import {
  MODELSTUDIO_BASE_URL,
  MODELSTUDIO_DEFAULT_COST as MODELSTUDIO_PROVIDER_DEFAULT_COST,
  MODELSTUDIO_DEFAULT_MODEL_ID as MODELSTUDIO_PROVIDER_DEFAULT_MODEL_ID,
  MODELSTUDIO_MODEL_CATALOG,
} from "./provider-catalog.js";

export const MODELSTUDIO_GLOBAL_BASE_URL = MODELSTUDIO_BASE_URL;
export const MODELSTUDIO_CN_BASE_URL = "https://coding.dashscope.aliyuncs.com/v1";
export const MODELSTUDIO_DEFAULT_COST = MODELSTUDIO_PROVIDER_DEFAULT_COST;
export const MODELSTUDIO_DEFAULT_MODEL_ID = MODELSTUDIO_PROVIDER_DEFAULT_MODEL_ID;
export const MODELSTUDIO_DEFAULT_MODEL_REF = `modelstudio/${MODELSTUDIO_DEFAULT_MODEL_ID}`;

export const MODELSTUDIO_STANDARD_CN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
export const MODELSTUDIO_STANDARD_GLOBAL_BASE_URL =
  "https://dashscope-intl.aliyuncs.com/compatible-mode/v1";

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
      (params.input as ("text" | "image")[]) ??
      (catalog?.input ? [...catalog.input] : ["text"]),
    cost: params.cost ?? catalog?.cost ?? MODELSTUDIO_DEFAULT_COST,
    contextWindow: params.contextWindow ?? catalog?.contextWindow ?? 262_144,
    maxTokens: params.maxTokens ?? catalog?.maxTokens ?? 65_536,
  };
}

export function buildModelStudioDefaultModelDefinition(): ModelDefinitionConfig {
  return buildModelStudioModelDefinition({ id: MODELSTUDIO_DEFAULT_MODEL_ID });
}
