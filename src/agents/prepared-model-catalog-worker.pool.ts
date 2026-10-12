/** Builds model-catalog worker pools that report their first close to the pool owner. */
import { resolveStateDir } from "../config/state-dir.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { resolveWorkerPoolSize } from "../infra/worker-pool-sizing.js";
import { WorkerTaskPool } from "../infra/worker-task-pool.js";
import { createPluginSourceCaptureRoot } from "../plugins/plugin-source-capture-directory.js";

export type PreparedModelCatalogWorkerData = {
  sourceCaptureDirectory: string;
  sourceCaptureManagedRoot?: string;
};

export const GATEWAY_CATALOG_WORKERS = resolveWorkerPoolSize("singleton");
// Leave room for source loaders and overlapping generations without inheriting the host heap budget.
const CATALOG_WORKER_HEAP_LIMIT_MB = 512;

/**
 * Without crash restart, the pool closes itself when its worker fails, exits or times out, even
 * while no task is waiting. It reports its first close so the owner can tell that from its own.
 */
export class CatalogWorkerTaskPool<Input, Output> extends WorkerTaskPool<Input, Output> {
  constructor(
    env: NodeJS.ProcessEnv,
    validateResult: (result: Output) => void,
    assertCurrent?: () => void,
    private readonly onClose?: (error?: Error) => void,
  ) {
    super({
      workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
      workerOptions: { resourceLimits: { maxOldGenerationSizeMb: CATALOG_WORKER_HEAP_LIMIT_MB } },
      workerClass: "singleton",
      // Only the inventory owner can replace captured code; idle retirement or crash restart
      // would import a different source generation into an existing publication.
      idleTimeoutMs: 0,
      restartOnError: false,
      prepareWorker: () => {
        assertCurrent?.();
        const capture = createPluginSourceCaptureRoot(
          resolveStateDir(env),
          "openclaw-model-catalog-",
        );
        return {
          releaseResources: capture.release,
          options: {
            workerData: {
              sourceCaptureDirectory: capture.directory,
              sourceCaptureManagedRoot: capture.managedRoot,
            } satisfies PreparedModelCatalogWorkerData,
            // Establish state/config before imported modules observe process.env.
            env,
          },
        };
      },
      validateResult,
    });
  }

  override close(error?: Error): Promise<void> {
    const first = !this.isClosed;
    const closed = super.close(error);
    if (first) {
      this.onClose?.(error);
    }
    return closed;
  }
}
