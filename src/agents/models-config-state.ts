// Process-wide models.json coordination state. Dynamic imports can load this
// module multiple times, so Symbol.for keeps write locks and ready-cache shared.
import fs from "node:fs/promises";
import path from "node:path";
import type { ModelProviderConfig } from "../config/types.models.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

export type ModelKeyNormalizer = (provider: string, model: string) => string;

type ModelsJsonCostCache = {
  providers: Record<string, ModelProviderConfig> | undefined;
};

type ModelsJsonState = {
  writeQueue: KeyedAsyncQueue;
  readyCache: Map<string, Promise<void>>;
  costCache: Map<string, ModelsJsonCostCache>;
};

export const MODELS_JSON_STATE = resolveGlobalSingleton<ModelsJsonState>(
  Symbol.for("openclaw.modelsJsonState"),
  () => ({
    writeQueue: new KeyedAsyncQueue(),
    readyCache: new Map(),
    costCache: new Map(),
  }),
);

/** Publish the catalog owner's read or write, including a known absent root catalog. */
export function publishModelsJsonCostSource(agentDir: string, contents: string | null) {
  let providers: Record<string, ModelProviderConfig> | undefined;
  try {
    // SAFETY: pricing's guarded index treats malformed provider data as absent; catalog parsing owns model validation.
    providers = contents ? (JSON.parse(contents) as ModelsJsonCostCache)?.providers : undefined;
  } catch {
    providers = undefined;
  }
  const source = { providers };
  MODELS_JSON_STATE.costCache.set(agentDir, source);
  pruneMapToMaxSize(MODELS_JSON_STATE.costCache, 128);
  return source;
}

async function readModelsJsonSource(agentDir: string, targetPath: string) {
  let contents: string | null;
  try {
    contents = await fs.readFile(targetPath, "utf8");
  } catch (error) {
    // SAFETY: readFile rejects with Node filesystem errors carrying an optional errno code.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    contents = null;
  }
  return { contents, pricing: publishModelsJsonCostSource(agentDir, contents) };
}

/** Fresh catalog captures publish in the same order as owning writes. */
export async function captureModelsJsonSource(agentDir: string) {
  const targetPath = path.join(agentDir, "models.json");
  return MODELS_JSON_STATE.writeQueue.enqueue(targetPath, () =>
    readModelsJsonSource(agentDir, targetPath),
  );
}

/** Pricing consumes any source published while its cold request waited on the owner. */
export async function captureModelsJsonCostSource(agentDir: string) {
  const cached = MODELS_JSON_STATE.costCache.get(agentDir);
  if (cached) {
    return cached;
  }
  const targetPath = path.join(agentDir, "models.json");
  return MODELS_JSON_STATE.writeQueue.enqueue(
    targetPath,
    async () =>
      MODELS_JSON_STATE.costCache.get(agentDir) ??
      (await readModelsJsonSource(agentDir, targetPath)).pricing,
  );
}
