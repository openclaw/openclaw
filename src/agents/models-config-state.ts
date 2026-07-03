// Process-wide models.json coordination state. Dynamic imports can load this
// module multiple times, so Symbol.for keeps write locks and ready-cache shared.
import path from "node:path";

const MODELS_JSON_STATE_KEY = Symbol.for("openclaw.modelsJsonState");

export type ModelsJsonReadyResult = {
  agentDir: string;
  wrote: boolean;
};

export type ModelsJsonReadyState = {
  fingerprint: string;
  result: ModelsJsonReadyResult;
};

type ModelsJsonState = {
  writeLocks: Map<string, Promise<void>>;
  readyCache: Map<string, Promise<ModelsJsonReadyState>>;
};

export const MODELS_JSON_STATE = (() => {
  const globalState = globalThis as typeof globalThis & {
    [MODELS_JSON_STATE_KEY]?: ModelsJsonState;
  };
  if (!globalState[MODELS_JSON_STATE_KEY]) {
    globalState[MODELS_JSON_STATE_KEY] = {
      writeLocks: new Map<string, Promise<void>>(),
      readyCache: new Map<string, Promise<ModelsJsonReadyState>>(),
    };
  }
  return globalState[MODELS_JSON_STATE_KEY];
})();

export async function withModelsJsonFileAccessLock<T>(
  targetPath: string,
  run: () => Promise<T>,
): Promise<T> {
  const lockKey = path.resolve(targetPath);
  const prior = MODELS_JSON_STATE.writeLocks.get(lockKey) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = prior.then(() => gate);
  MODELS_JSON_STATE.writeLocks.set(lockKey, pending);
  try {
    await prior;
    return await run();
  } finally {
    release();
    if (MODELS_JSON_STATE.writeLocks.get(lockKey) === pending) {
      MODELS_JSON_STATE.writeLocks.delete(lockKey);
    }
  }
}

/** Clear models.json write/ready caches for tests. */
export function resetModelsJsonReadyCacheForTest(): void {
  MODELS_JSON_STATE.writeLocks.clear();
  MODELS_JSON_STATE.readyCache.clear();
}
