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

export type LiteRtLmConfigResolutionInput = {
  modelId: string;
  env?: NodeJS.ProcessEnv;
  providerConfig?: {
    pythonPath?: string;
    shimPath?: string;
    modelFile?: string;
    timeoutMs?: number;
    backend?: string;
  };
};

export function resolveLiteRtLmRuntimeConfig(
  input: LiteRtLmConfigResolutionInput,
): LiteRtLmRuntimeConfig {
  const env = input.env ?? process.env;
  const providerConfig = input.providerConfig ?? {};

  const pythonPath =
    providerConfig.pythonPath?.trim() || env.OPENCLAW_LITERTLM_PYTHON?.trim() || "python3";

  const shimPath =
    providerConfig.shimPath?.trim() ||
    env.OPENCLAW_LITERTLM_SHIM?.trim() ||
    "extensions/litertlm/scripts/litertlm_provider_shim.py";

  const modelFile =
    providerConfig.modelFile?.trim() || env.OPENCLAW_LITERTLM_MODEL_FILE?.trim() || "";

  const timeoutMs =
    providerConfig.timeoutMs && providerConfig.timeoutMs > 0
      ? providerConfig.timeoutMs
      : Number(env.OPENCLAW_LITERTLM_TIMEOUT_MS || 120000);

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
