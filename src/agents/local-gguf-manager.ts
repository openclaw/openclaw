import { log } from "./pi-embedded-runner/logger.js";

// Simplified types for node-llama-cpp to avoid hard dependency imports
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type LlamaModel = Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
type Llama = Record<string, unknown>;

interface LoadedModel {
  model: LlamaModel;
  lastUsed: number;
  path: string;
}

const DEFAULT_MAX_CACHED_MODELS = 5;

export class LocalGgufModelManager {
  private static instance: LocalGgufModelManager;
  private loadedModels: Map<string, LoadedModel> = new Map();
  private llama: Llama | null = null;
  private nodeLlama: Record<string, unknown> | null = null;
  private maxCachedModels = DEFAULT_MAX_CACHED_MODELS;

  private constructor() {}

  static getInstance(): LocalGgufModelManager {
    if (!LocalGgufModelManager.instance) {
      LocalGgufModelManager.instance = new LocalGgufModelManager();
    }
    return LocalGgufModelManager.instance;
  }

  configure(params: { maxCachedModels?: number }) {
    if (typeof params.maxCachedModels === "number" && params.maxCachedModels > 0) {
      this.maxCachedModels = params.maxCachedModels;
      void this.manageCache();
    }
  }

  async getModel(modelPath: string): Promise<LlamaModel> {
    const existing = this.loadedModels.get(modelPath);
    if (existing) {
      log.info(`[LocalGgufModelManager] Reusing loaded model: ${modelPath}`);
      existing.lastUsed = Date.now();
      return existing.model;
    }

    await this.ensureLlama();
    await this.manageCache();

    log.info(`[LocalGgufModelManager] Loading model: ${modelPath}`);
    try {
      const model = await (this.llama as Record<string, Function>).loadModel({
        modelPath: modelPath,
      });

      this.loadedModels.set(modelPath, {
        model,
        lastUsed: Date.now(),
        path: modelPath,
      });

      return model;
    } catch (err) {
      log.error(
        `[LocalGgufModelManager] Failed to load model ${modelPath}:`,
        err as Record<string, unknown>,
      );
      throw err;
    }
  }

  private async ensureLlama() {
    if (this.llama) {
      return;
    }

    log.info("[LocalGgufModelManager] Initializing node-llama-cpp runtime...");
    this.nodeLlama = (await import("node-llama-cpp")) as unknown as Record<string, unknown>;
    this.llama = await (this.nodeLlama.getLlama as () => Promise<Llama>)();
  }

  async unloadModel(modelPath: string) {
    const entry = this.loadedModels.get(modelPath);
    if (entry) {
      log.info(`[LocalGgufModelManager] Explicitly unloading model: ${modelPath}`);
      if (typeof entry.model.dispose === "function") {
        entry.model.dispose();
      }
      this.loadedModels.delete(modelPath);
    }
  }

  async clearCache() {
    log.info("[LocalGgufModelManager] Clearing all cached models");
    for (const path of this.loadedModels.keys()) {
      await this.unloadModel(path);
    }
  }

  private async manageCache() {
    if (this.loadedModels.size < this.maxCachedModels) {
      return;
    }

    // Find least recently used model
    let lruPath: string | null = null;
    let oldest = Infinity;

    for (const [path, data] of this.loadedModels.entries()) {
      if (data.lastUsed < oldest) {
        oldest = data.lastUsed;
        lruPath = path;
      }
    }

    if (lruPath) {
      void this.unloadModel(lruPath);
    }
  }
}
