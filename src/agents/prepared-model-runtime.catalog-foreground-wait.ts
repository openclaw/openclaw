import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

const MODEL_CATALOG_FOREGROUND_WAIT_MS = 5_000;
const MODEL_CATALOG_FOREGROUND_WAIT_MAX_MS = 12_000;

export function resolvePreparedModelCatalogForegroundWaitMs(requestedWaitMs?: number): number {
  return Math.min(
    MODEL_CATALOG_FOREGROUND_WAIT_MAX_MS,
    Math.max(
      MODEL_CATALOG_FOREGROUND_WAIT_MS,
      typeof requestedWaitMs === "number" && Number.isFinite(requestedWaitMs)
        ? requestedWaitMs
        : MODEL_CATALOG_FOREGROUND_WAIT_MS,
    ),
  );
}

export async function waitForPreparedModelCatalogForeground(params: {
  acquisition: Promise<ModelCatalogSnapshot>;
  waitMs: number;
  fallback: () => ModelCatalogSnapshot;
}): Promise<ModelCatalogSnapshot> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      params.acquisition,
      new Promise<ModelCatalogSnapshot>((resolve, reject) => {
        timer = setTimeout(() => {
          try {
            resolve(params.fallback());
          } catch (error) {
            reject(
              error instanceof Error ? error : new Error("Prepared model catalog fallback failed"),
            );
          }
        }, params.waitMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
