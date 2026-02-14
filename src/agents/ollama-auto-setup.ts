import { DEFAULT_MODEL } from "./defaults.js";
import { listOllamaModels } from "./ollama-health.js";
import { pullOllamaModel, type PullOptions } from "./ollama-model-pull.js";
import { OLLAMA_BASE_URL } from "./ollama-shared.js";

export interface EnsureModelResult {
  alreadyAvailable: boolean;
  pulled: boolean;
  model: string;
  error?: string;
}

export async function ensureDefaultModel(opts?: PullOptions): Promise<EnsureModelResult> {
  const baseUrl = (opts?.baseUrl ?? OLLAMA_BASE_URL).replace(/\/+$/, "");
  const model = DEFAULT_MODEL;

  try {
    const models = await listOllamaModels(baseUrl);
    const available = models.some((m) => m.name === model || m.name === `${model}:latest`);
    if (available) {
      return { alreadyAvailable: true, pulled: false, model };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { alreadyAvailable: false, pulled: false, model, error: msg };
  }

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
