/**
 * Model Optimizer - Select best model for $0 budget (free tier)
 */

export type TaskType = "chat" | "code" | "analysis" | "embedding";

export interface ModelInfo {
  provider: string;
  model: string;
  contextWindow: number;
  supports: TaskType[];
  free: boolean;
}

const AVAILABLE_MODELS: ModelInfo[] = [
  {
    provider: "groq",
    model: "llama-3.3-70b-versatile",
    contextWindow: 128000,
    supports: ["chat", "code", "analysis"],
    free: true,
  },
  {
    provider: "groq",
    model: "mixtral-8x7b-32768",
    contextWindow: 32768,
    supports: ["chat", "code", "analysis"],
    free: true,
  },
  {
    provider: "groq",
    model: "gemma2-9b-8192",
    contextWindow: 8192,
    supports: ["chat", "code"],
    free: true,
  },
  {
    provider: "ollama",
    model: "llama3.3",
    contextWindow: 128000,
    supports: ["chat", "code", "analysis"],
    free: true,
  },
  {
    provider: "ollama",
    model: "qwen2.5-coder",
    contextWindow: 32768,
    supports: ["code"],
    free: true,
  },
  {
    provider: "ollama",
    model: "nomic-embed-text",
    contextWindow: 8192,
    supports: ["embedding"],
    free: true,
  },
];

const PRIORITY_ORDER: string[] = ["groq", "ollama"];

export class ModelOptimizer {
  private modelPerformance: Map<string, { success: number; failure: number }>;
  private ollamaAvailable: boolean;

  constructor(ollamaAvailable: boolean = false) {
    this.modelPerformance = new Map();
    this.ollamaAvailable = ollamaAvailable;
  }

  selectModel(taskType: TaskType): ModelInfo {
    const candidates = AVAILABLE_MODELS.filter((m) => m.free && m.supports.includes(taskType));

    if (candidates.length === 0) {
      return {
        provider: "groq",
        model: "llama-3.3-70b-versatile",
        contextWindow: 128000,
        supports: ["chat", "code", "analysis"],
        free: true,
      };
    }

    const sortedCandidates = candidates.sort((a, b) => {
      const aIndex = PRIORITY_ORDER.indexOf(a.provider);
      const bIndex = PRIORITY_ORDER.indexOf(b.provider);

      if (aIndex !== bIndex) {
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
      }

      if (a.provider === "ollama" && !this.ollamaAvailable) return 1;
      if (b.provider === "ollama" && !this.ollamaAvailable) return -1;

      const aPerf = this.modelPerformance.get(`${a.provider}:${a.model}`) || {
        success: 0,
        failure: 0,
      };
      const bPerf = this.modelPerformance.get(`${b.provider}:${b.model}`) || {
        success: 0,
        failure: 0,
      };

      const aScore = aPerf.success - aPerf.failure * 2;
      const bScore = bPerf.success - bPerf.failure * 2;

      return bScore - aScore;
    });

    return sortedCandidates[0];
  }

  recordSuccess(provider: string, model: string): void {
    const key = `${provider}:${model}`;
    const perf = this.modelPerformance.get(key) || { success: 0, failure: 0 };
    perf.success++;
    this.modelPerformance.set(key, perf);
  }

  recordFailure(provider: string, model: string): void {
    const key = `${provider}:${model}`;
    const perf = this.modelPerformance.get(key) || { success: 0, failure: 0 };
    perf.failure++;
    this.modelPerformance.set(key, perf);
  }

  getFallbacks(taskType: TaskType): ModelInfo[] {
    const candidates = AVAILABLE_MODELS.filter((m) => m.free && m.supports.includes(taskType));

    const selected = this.selectModel(taskType);

    return candidates
      .filter((m) => m.provider !== selected.provider || m.model !== selected.model)
      .sort((a, b) => {
        const aIndex = PRIORITY_ORDER.indexOf(a.provider);
        const bIndex = PRIORITY_ORDER.indexOf(b.provider);
        if (aIndex !== bIndex) return aIndex - bIndex;
        return b.contextWindow - a.contextWindow;
      });
  }

  setOllamaAvailable(available: boolean): void {
    this.ollamaAvailable = available;
  }
}
