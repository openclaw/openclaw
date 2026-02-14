import os from "os";

export interface ModelProfile {
  name: string;
  contextWindow: number;
  ramGB: number;
  description: string;
}

export const OLLAMA_MODEL_PROFILES: Record<
  string,
  { contextWindow: number; ramGB: number; description: string }
> = {
  "gemma3:4b": {
    contextWindow: 8192,
    ramGB: 3,
    description: "Google Gemma 3 4B — fast, efficient",
  },
  "gemma3:12b": { contextWindow: 8192, ramGB: 8, description: "Google Gemma 3 12B — balanced" },
  "gemma3:27b": { contextWindow: 8192, ramGB: 16, description: "Google Gemma 3 27B — powerful" },
  "llama3.3": { contextWindow: 131072, ramGB: 4, description: "Meta Llama 3.3 8B — long context" },
  "qwen2.5:7b": { contextWindow: 32768, ramGB: 5, description: "Qwen 2.5 7B — multilingual" },
  "qwen2.5-coder:7b": {
    contextWindow: 32768,
    ramGB: 5,
    description: "Qwen 2.5 Coder — code specialist",
  },
  "deepseek-r1:8b": { contextWindow: 65536, ramGB: 5, description: "DeepSeek R1 8B — reasoning" },
  "mistral:7b": {
    contextWindow: 32768,
    ramGB: 5,
    description: "Mistral 7B — fast general purpose",
  },
  "phi4:14b": {
    contextWindow: 16384,
    ramGB: 9,
    description: "Microsoft Phi-4 — compact powerhouse",
  },
  "codellama:7b": {
    contextWindow: 16384,
    ramGB: 4,
    description: "Code Llama 7B — code generation",
  },
};

/** Get model profile by exact or prefix match. */
export function getModelProfile(modelName: string): ModelProfile | undefined {
  if (OLLAMA_MODEL_PROFILES[modelName]) {
    return { name: modelName, ...OLLAMA_MODEL_PROFILES[modelName] };
  }
  // Prefix match: longest key that matches followed by separator
  let bestKey: string | undefined;
  for (const key of Object.keys(OLLAMA_MODEL_PROFILES)) {
    if (modelName.startsWith(key) && modelName.length > key.length) {
      const next = modelName[key.length];
      if ("-:.".includes(next) && (!bestKey || key.length > bestKey.length)) {
        bestKey = key;
      }
    }
  }
  if (bestKey) {
    return { name: bestKey, ...OLLAMA_MODEL_PROFILES[bestKey] };
  }
  return undefined;
}

/** Models that fit in the given RAM, sorted by capability descending. */
export function recommendModelsForRam(availableRamGB: number): ModelProfile[] {
  return Object.entries(OLLAMA_MODEL_PROFILES)
    .filter(([, p]) => p.ramGB <= availableRamGB)
    .map(([name, p]) => ({ name, ...p }))
    .toSorted((a, b) => b.ramGB - a.ramGB || b.contextWindow - a.contextWindow);
}

/** Usable system RAM in GB (total minus ~2GB OS overhead). */
export async function getSystemRam(): Promise<number> {
  return Math.max(0, os.totalmem() / 1024 ** 3 - 2);
}
