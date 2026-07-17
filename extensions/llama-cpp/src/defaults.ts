import os from "node:os";
import path from "node:path";
import type {
  ModelDefinitionConfig,
  ModelProviderConfig,
} from "openclaw/plugin-sdk/provider-model-shared";

export const LLAMA_CPP_PROVIDER_ID = "llama-cpp";
export const LLAMA_CPP_PROVIDER_LABEL = "Local model (llama.cpp)";
const LLAMA_CPP_LOCAL_AUTH_MARKER = "llama-cpp-local";
const LLAMA_CPP_LOCAL_BASE_URL = "local://llama-cpp";

export function resolveLlamaCppSyntheticApiKey(): string {
  return LLAMA_CPP_LOCAL_AUTH_MARKER;
}

export const DEFAULT_LLAMA_CPP_MODEL_ID = "qwen3-4b-instruct-2507-q4_k_m";
export const DEFAULT_LLAMA_CPP_MODEL_REF = `${LLAMA_CPP_PROVIDER_ID}/${DEFAULT_LLAMA_CPP_MODEL_ID}`;
// Verified 2026-07-16: 2,497,280,736 bytes (about 2.5 GB) from the public
// bartowski mirror. Qwen does not publish an official Instruct-2507 GGUF repo.
export const DEFAULT_LLAMA_CPP_MODEL_URI =
  "hf:bartowski/Qwen_Qwen3-4B-Instruct-2507-GGUF/Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
export const DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE =
  "hf_bartowski_Qwen_Qwen3-4B-Instruct-2507-Q4_K_M.gguf";
export const DEFAULT_LLAMA_CPP_MODEL_SIZE_BYTES = 2_497_280_736;
export const DEFAULT_LLAMA_CPP_CONTEXT_SIZE = 8192;

export function resolveLlamaCppModelCacheDir(provider?: ModelProviderConfig): string {
  const configured = provider?.params?.modelCacheDir;
  return typeof configured === "string" && configured.trim()
    ? resolveHomePath(configured.trim())
    : path.join(os.homedir(), ".node-llama-cpp", "models");
}

function resolveHomePath(value: string): string {
  if (value === "~") {
    return os.homedir();
  }
  if (value.startsWith("~/")) {
    return path.join(os.homedir(), value.slice(2));
  }
  return value;
}

export function resolveLlamaCppModelSource(model: {
  id: string;
  params?: Record<string, unknown>;
}): string {
  const configured = model.params?.modelPath;
  if (typeof configured === "string" && configured.trim()) {
    return resolveHomePath(configured.trim());
  }
  return model.id === DEFAULT_LLAMA_CPP_MODEL_ID
    ? DEFAULT_LLAMA_CPP_MODEL_URI
    : resolveHomePath(model.id);
}

export function resolveCachedLlamaCppModelPath(params: {
  model: Pick<ModelDefinitionConfig, "id" | "params">;
  provider?: ModelProviderConfig;
}): string | null {
  const source = resolveLlamaCppModelSource(params.model);
  const cacheDir = resolveLlamaCppModelCacheDir(params.provider);
  if (source === DEFAULT_LLAMA_CPP_MODEL_URI) {
    return path.join(cacheDir, DEFAULT_LLAMA_CPP_MODEL_CACHE_FILE);
  }
  if (/^hf:/i.test(source)) {
    return null;
  }
  if (/^https?:\/\//i.test(source)) {
    return null;
  }
  const localPath = resolveHomePath(source);
  return path.isAbsolute(localPath) ? localPath : path.resolve(cacheDir, localPath);
}

function buildDefaultLlamaCppModel(): ModelDefinitionConfig {
  return {
    id: DEFAULT_LLAMA_CPP_MODEL_ID,
    name: "Qwen3 4B Instruct 2507 (Q4_K_M)",
    api: "openai-completions",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
    contextTokens: DEFAULT_LLAMA_CPP_CONTEXT_SIZE,
    maxTokens: 2048,
    params: {
      modelPath: DEFAULT_LLAMA_CPP_MODEL_URI,
      contextSize: "auto",
    },
    compat: { supportsTools: true, supportsUsageInStreaming: true },
  };
}

export function buildLlamaCppProviderConfig(existing?: ModelProviderConfig): ModelProviderConfig {
  const defaultModel = buildDefaultLlamaCppModel();
  const configuredModels = existing?.models ?? [];
  const models = configuredModels.some((model) => model.id === defaultModel.id)
    ? configuredModels
    : [...configuredModels, defaultModel];
  return {
    ...existing,
    baseUrl: existing?.baseUrl ?? LLAMA_CPP_LOCAL_BASE_URL,
    api: existing?.api ?? "openai-completions",
    models,
  };
}
