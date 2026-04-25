import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";
import {
  GOOGLE_VERTEX_CREDENTIALS_MARKER,
  resolveGoogleVertexBaseUrl,
  resolveGoogleVertexClientRegion,
  resolveGoogleVertexProjectId,
} from "./vertex-region.js";

export const GOOGLE_VERTEX_DEFAULT_MODEL_ID = "gemini-3-pro-preview";

const GOOGLE_VERTEX_DEFAULT_CONTEXT_WINDOW = 1_000_000;

function buildGoogleVertexModel(params: {
  id: string;
  name: string;
  reasoning: boolean;
  input: ModelDefinitionConfig["input"];
  cost: ModelDefinitionConfig["cost"];
  maxTokens: number;
  contextWindow?: number;
}): ModelDefinitionConfig {
  return {
    id: params.id,
    name: params.name,
    reasoning: params.reasoning,
    input: params.input,
    cost: params.cost,
    contextWindow: params.contextWindow ?? GOOGLE_VERTEX_DEFAULT_CONTEXT_WINDOW,
    maxTokens: params.maxTokens,
  };
}

function buildGoogleVertexCatalog(): ModelDefinitionConfig[] {
  return [
    buildGoogleVertexModel({
      id: GOOGLE_VERTEX_DEFAULT_MODEL_ID,
      name: "Gemini 3 Pro (Preview)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.5625 },
      maxTokens: 65536,
      contextWindow: 2_000_000,
    }),
    buildGoogleVertexModel({
      id: "gemini-3-flash-preview",
      name: "Gemini 3 Flash (Preview)",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.375 },
      maxTokens: 65536,
    }),
  ];
}

export function buildGoogleVertexProvider(params?: {
  env?: NodeJS.ProcessEnv;
}): ModelProviderConfig {
  const env = params?.env ?? process.env;
  const region = resolveGoogleVertexClientRegion({ env }) ?? "global";
  const baseUrl = resolveGoogleVertexBaseUrl(region);
  const project = resolveGoogleVertexProjectId(env);

  return {
    baseUrl,
    api: "google-generative-ai",
    apiKey: GOOGLE_VERTEX_CREDENTIALS_MARKER,
    ...(project ? { headers: { "x-goog-user-project": project } } : {}),
    models: buildGoogleVertexCatalog(),
  };
}

export function mergeImplicitGoogleVertexProvider(params: {
  existing?: ModelProviderConfig;
  implicit: ModelProviderConfig;
}): ModelProviderConfig {
  const { existing, implicit } = params;
  if (!existing) {
    return implicit;
  }
  return {
    ...implicit,
    ...existing,
    headers: { ...implicit.headers, ...existing.headers },
    models:
      Array.isArray(existing.models) && existing.models.length > 0
        ? existing.models
        : implicit.models,
  };
}
