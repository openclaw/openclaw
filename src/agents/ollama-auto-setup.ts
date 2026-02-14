import { DEFAULT_MODEL } from "./defaults.js";
import { pullOllamaModel, type PullOptions } from "./ollama-model-pull.js";
import { OLLAMA_NATIVE_BASE_URL } from "./ollama-stream.js";

export interface EnsureModelResult {
  alreadyAvailable: boolean;
  pulled: boolean;
  model: string;
  error?: string;
}

interface OllamaTagsResponse {
  models: Array<{ name: string }>;
}

export async function ensureDefaultModel(opts?: PullOptions): Promise<EnsureModelResult> {
  const baseUrl = (opts?.baseUrl ?? OLLAMA_NATIVE_BASE_URL).replace(/\/+$/, "");
  const model = DEFAULT_MODEL;

  // Check if model is already available
  let tags: OllamaTagsResponse;
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: opts?.signal });
    if (!response.ok) {
      const text = await response.text().catch(() => "unknown error");
      return {
        alreadyAvailable: false,
        pulled: false,
        model,
        error: `HTTP ${response.status}: ${text}`,
      };
    }
    tags = (await response.json()) as OllamaTagsResponse;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { alreadyAvailable: false, pulled: false, model, error: msg };
  }

  const available = tags.models?.some((m) => m.name === model || m.name === `${model}:latest`);
  if (available) {
    return { alreadyAvailable: true, pulled: false, model };
  }

  // Pull the model
  const result = await pullOllamaModel(model, {
    baseUrl,
    onProgress: opts?.onProgress,
    signal: opts?.signal,
  });
  if (result.success) {
    return { alreadyAvailable: false, pulled: true, model };
  }
  return { alreadyAvailable: false, pulled: false, model, error: result.error };
}
