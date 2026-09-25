// Process-wide models.json coordination state. Dynamic imports can load this
// module multiple times, so Symbol.for keeps write locks and ready-cache shared.
import type { RawModelCostConfig } from "@openclaw/llm-core";
import type { ModelProviderConfig } from "../config/types.models.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";

const MODELS_JSON_STATE_KEY = Symbol.for("openclaw.modelsJsonState");

export type ModelsJsonReadyResult = {
  agentDir: string;
  wrote: boolean;
};

export type ModelKeyNormalizer = (provider: string, model: string) => string;

type ModelsJsonCostCache = {
  providers: Record<string, ModelProviderConfig> | undefined;
  entries: WeakMap<ModelKeyNormalizer, Map<string, RawModelCostConfig>>;
};

type ModelsJsonState = {
  writeQueue: KeyedAsyncQueue;
  readyCache: Map<string, Promise<ModelsJsonReadyResult>>;
  costCache: Map<string, ModelsJsonCostCache>;
};

export const MODELS_JSON_STATE = (() => {
  const globalState = globalThis as typeof globalThis & {
    [MODELS_JSON_STATE_KEY]?: ModelsJsonState;
  };
  if (!globalState[MODELS_JSON_STATE_KEY]) {
    globalState[MODELS_JSON_STATE_KEY] = {
      writeQueue: new KeyedAsyncQueue(),
      readyCache: new Map(),
      costCache: new Map(),
    };
  }
  return globalState[MODELS_JSON_STATE_KEY];
})();
