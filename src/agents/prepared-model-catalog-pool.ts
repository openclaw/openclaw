/** Catalog compute-pool construction and original source-capture custody. */
import { isPromiseLike } from "@openclaw/normalization-core/promise-like";
import { cloneEnvWithPlatformSemantics } from "../config/config-env-vars.js";
import { resolveStateDir } from "../config/state-dir.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createSqliteLifecycleAggregateError } from "../infra/sqlite-lifecycle-errors.js";
import { WorkerTaskError, WorkerTaskPool } from "../infra/worker-task-pool.js";
import { startPluginSourceCaptureRoot } from "../plugins/plugin-source-capture-directory.js";
import { createDeferredCore } from "../shared/deferred.js";
import type {
  PreparedModelCatalogWorkerData,
  PreparedModelCatalogWorkerTask,
  PreparedModelWorkerResult,
} from "./prepared-model-catalog-worker.types.js";
import {
  capturePreparedModelRuntimeLifetime,
  registerPreparedModelRuntimeClose,
} from "./prepared-model-runtime.lifecycle.js";

export const GATEWAY_CATALOG_WORKERS = 1;
// Leave room for source loaders and overlapping generations without inheriting the host heap budget.
const CATALOG_WORKER_HEAP_LIMIT_MB = 512;
export type CatalogPool = Pick<
  WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>,
  "run" | "close" | "isClosed" | "getSnapshot"
>;

export async function createCatalogPool(
  env: NodeJS.ProcessEnv,
  validateResult: (result: PreparedModelWorkerResult) => void,
  assertCurrent?: () => void,
): Promise<CatalogPool> {
  const capturedEnv = cloneEnvWithPlatformSemantics(env);
  const assertLifetime = capturePreparedModelRuntimeLifetime();
  assertCurrent?.();
  const workerUrl = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog);
  const acquisitionSettled = createDeferredCore();
  let acquiredCleanup: (() => Promise<void>) | undefined;
  let closeReason: Error | undefined;
  const unregisterAcquisition = registerPreparedModelRuntimeClose(async (error) => {
    closeReason ??= error;
    await acquisitionSettled.promise;
    await acquiredCleanup?.();
  });
  try {
    const admission = startPluginSourceCaptureRoot(
      resolveStateDir(capturedEnv),
      "openclaw-model-catalog-",
    );
    let availableCapture: Awaited<typeof admission.result> | undefined;
    let captureRelease: Promise<void> | undefined;
    const releaseCapture = () =>
      (captureRelease ??= admission.release(closeReason).then(() => {
        availableCapture = undefined;
      }));
    const closeCapture = async () => {
      const release = releaseCapture();
      try {
        await release;
      } catch (error) {
        if (captureRelease === release) {
          captureRelease = undefined;
        }
        throw error;
      }
    };
    acquiredCleanup = async () => {
      await closeCapture();
      acquiredCleanup = undefined;
      unregisterAcquisition();
    };
    try {
      const capture = await admission.result;
      availableCapture = capture;
      assertCurrent?.();
      assertLifetime();
      capture.assertCurrent();
      let sourceLoss: { error: unknown; closing: Promise<void> | undefined } | undefined;
      const pool = new WorkerTaskPool<PreparedModelCatalogWorkerTask, PreparedModelWorkerResult>({
        workerUrl,
        workerOptions: { resourceLimits: { maxOldGenerationSizeMb: CATALOG_WORKER_HEAP_LIMIT_MB } },
        maxWorkers: GATEWAY_CATALOG_WORKERS,
        // Only the inventory owner can replace captured code; idle retirement or crash restart
        // would import a different source generation into an existing publication.
        idleTimeoutMs: 0,
        restartOnError: false,
        prepareWorker: () => {
          assertLifetime();
          assertCurrent?.();
          assertCaptureCurrent();
          if (!availableCapture) {
            throw new WorkerTaskError("catalog source capture was already released", "unavailable");
          }
          const prepared = {
            releaseResources: releaseCapture,
            options: {
              workerData: {
                sourceCaptureDirectory: capture.directory,
                sourceCaptureManagedRoot: capture.managedRoot,
              } satisfies PreparedModelCatalogWorkerData,
              // Establish state/config before imported modules observe process.env.
              env: capturedEnv,
            },
          };
          // This pool neither idles nor restarts. Its sole Worker now owns the original root.
          availableCapture = undefined;
          return prepared;
        },
        validateResult: (result) => {
          assertCaptureCurrent();
          validateResult(result);
        },
      });
      const assertCaptureCurrent = () => {
        try {
          capture.assertCurrent();
        } catch (error) {
          sourceLoss ??= {
            error,
            closing: pool.close(error instanceof Error ? error : new Error(String(error))),
          };
          throw sourceLoss.error;
        }
      };
      let closing: Promise<void> | undefined;
      const closePool = (error?: Error) =>
        (closing ??= (async () => {
          const failures: unknown[] = [];
          let joined = false;
          const sourceClosing = sourceLoss?.closing;
          try {
            await (sourceClosing ?? pool.close(error));
            joined = true;
          } catch (closeError) {
            if (sourceLoss && sourceLoss.closing === sourceClosing) {
              sourceLoss.closing = undefined;
            }
            failures.push(closeError);
          }
          if (captureRelease || joined || availableCapture) {
            // The pool's best-effort callback cannot discard this owner's first release failure.
            try {
              await closeCapture();
            } catch (releaseError) {
              failures.push(releaseError);
            }
          }
          if (failures.length === 1) {
            throw failures[0];
          }
          if (failures.length > 1) {
            throw new AggregateError(failures, "Catalog worker and capture failed to close", {
              cause: failures[0],
            });
          }
        })().finally(() => {
          closing = undefined;
        }));
      const result: CatalogPool = {
        run: (input, options) =>
          pool
            .run(() => {
              assertCaptureCurrent();
              const prepared = typeof input === "function" ? input() : input;
              if (isPromiseLike<PreparedModelCatalogWorkerTask>(prepared)) {
                return Promise.resolve(prepared).then((value) => {
                  assertCaptureCurrent();
                  return value;
                });
              }
              assertCaptureCurrent();
              return prepared;
            }, options)
            .catch(async (error: unknown) => {
              const loss = sourceLoss;
              if (!loss) {
                throw error;
              }
              try {
                await closePool();
              } catch (cleanupError) {
                throw createSqliteLifecycleAggregateError(
                  [loss.error, cleanupError],
                  "Catalog source authority and cleanup failed",
                  loss.error,
                );
              }
              throw loss.error;
            }),
        getSnapshot: () => pool.getSnapshot(),
        get isClosed() {
          return pool.isClosed;
        },
        close: closePool,
      };
      acquiredCleanup = undefined;
      unregisterAcquisition();
      return result;
    } catch (error) {
      try {
        await releaseCapture();
        acquiredCleanup = undefined;
        unregisterAcquisition();
      } catch (releaseError) {
        throw createSqliteLifecycleAggregateError(
          [error, releaseError],
          "Catalog preparation and cleanup failed",
          error,
        );
      }
      throw error;
    }
  } finally {
    if (!acquiredCleanup) {
      unregisterAcquisition();
    }
    acquisitionSettled.resolve();
  }
}
