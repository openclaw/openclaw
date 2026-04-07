import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDER_ID } from "./provider-models.js";
import type { LiteRtLmModelPreference } from "./provider-models.js";

export type LiteRtLmRuntimeConfig = {
  pythonPath: string;
  shimPath: string;
  modelFile: string;
  timeoutMs: number;
  backend: "CPU" | string;
};

export type LiteRtLmShimRequest = {
  version: 1;
  requestId?: string;
  model: {
    id: string;
    file: string;
  };
  runtime: {
    backend: string;
    timeoutMs: number;
  };
  input: {
    system?: string;
    prompt?: string;
    messages?: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
  };
  options?: {
    maxOutputTokens?: number;
    temperature?: number;
  };
};

export type LiteRtLmShimSuccess = {
  ok: true;
  version: 1;
  requestId?: string;
  model?: {
    id?: string;
  };
  output: {
    text: string;
    stopReason?: string;
  };
  usage?: {
    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
  };
  diagnostics?: {
    backend?: string;
  };
};

export type LiteRtLmShimFailure = {
  ok: false;
  version: 1;
  requestId?: string;
  error: {
    type: "configuration" | "environment" | "runtime";
    code: string;
    message: string;
  };
};

export type LiteRtLmShimResponse = LiteRtLmShimSuccess | LiteRtLmShimFailure;

export type LiteRtLmProviderConfig = {
  pythonPath?: string;
  shimPath?: string;
  modelFile?: string;
  timeoutMs?: number;
  backend?: string;
};

type LiteRtLmConfigShape = {
  models?: {
    providers?: Record<string, Record<string, unknown>>;
  };
};

export type LiteRtLmConfigResolutionInput = {
  model: LiteRtLmModelPreference | { modelId: string };
  env?: NodeJS.ProcessEnv;
  providerConfig?: LiteRtLmProviderConfig;
  config?: LiteRtLmConfigShape;
};

export function getDefaultLiteRtLmBundledShimPath() {
  return path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../scripts/litertlm_provider_shim.py",
  );
}

export function getLiteRtLmProviderConfig(config?: LiteRtLmConfigShape): LiteRtLmProviderConfig {
  const raw = config?.models?.providers?.[PROVIDER_ID];
  if (!raw) {
    return {};
  }
  return {
    pythonPath: typeof raw.pythonPath === "string" ? raw.pythonPath : undefined,
    shimPath: typeof raw.shimPath === "string" ? raw.shimPath : undefined,
    modelFile: typeof raw.modelFile === "string" ? raw.modelFile : undefined,
    timeoutMs: typeof raw.timeoutMs === "number" ? raw.timeoutMs : undefined,
    backend: typeof raw.backend === "string" ? raw.backend : undefined,
  };
}

export function resolveLiteRtLmRuntimeConfig(
  input: LiteRtLmConfigResolutionInput,
): LiteRtLmRuntimeConfig {
  const env = input.env ?? process.env;
  const providerConfig = {
    ...getLiteRtLmProviderConfig(input.config),
    ...(input.providerConfig ?? {}),
  };

  const pythonPath =
    providerConfig.pythonPath?.trim() || env.OPENCLAW_LITERTLM_PYTHON?.trim() || "python3";

  const shimPath =
    providerConfig.shimPath?.trim() ||
    env.OPENCLAW_LITERTLM_SHIM?.trim() ||
    getDefaultLiteRtLmBundledShimPath();

  const modelFile =
    providerConfig.modelFile?.trim() || env.OPENCLAW_LITERTLM_MODEL_FILE?.trim() || "";

  const timeoutMsRaw =
    providerConfig.timeoutMs && providerConfig.timeoutMs > 0
      ? providerConfig.timeoutMs
      : Number(env.OPENCLAW_LITERTLM_TIMEOUT_MS || 120000);

  const timeoutMs = Number.isFinite(timeoutMsRaw) && timeoutMsRaw > 0 ? timeoutMsRaw : 120000;

  const backend = providerConfig.backend?.trim() || env.OPENCLAW_LITERTLM_BACKEND?.trim() || "CPU";

  return {
    pythonPath,
    shimPath,
    modelFile,
    timeoutMs,
    backend,
  };
}

export function buildLiteRtLmShimRequest(params: {
  modelId: string;
  runtimeConfig: LiteRtLmRuntimeConfig;
  prompt?: string;
  system?: string;
  messages?: LiteRtLmShimRequest["input"]["messages"];
  maxOutputTokens?: number;
  temperature?: number;
  requestId?: string;
}): LiteRtLmShimRequest {
  return {
    version: 1,
    requestId: params.requestId,
    model: {
      id: params.modelId,
      file: params.runtimeConfig.modelFile,
    },
    runtime: {
      backend: params.runtimeConfig.backend,
      timeoutMs: params.runtimeConfig.timeoutMs,
    },
    input: {
      ...(params.system ? { system: params.system } : {}),
      ...(params.prompt ? { prompt: params.prompt } : {}),
      ...(params.messages?.length ? { messages: params.messages } : {}),
    },
    options: {
      ...(params.maxOutputTokens ? { maxOutputTokens: params.maxOutputTokens } : {}),
      ...(typeof params.temperature === "number" ? { temperature: params.temperature } : {}),
    },
  };
}
