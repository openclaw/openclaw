/** Builds model-catalog worker pools that report their first close to the pool owner. */
import type { MessagePort } from "node:worker_threads";
import { toErrorObject } from "@openclaw/normalization-core/error-coercion";
import { WorkerTaskPoolCore } from "@openclaw/worker-runtime";
import { resolveStateDir } from "../config/state-dir.js";
import {
  getDatabaseEngineSelection,
  type DatabaseEngineSelection,
} from "../infra/database-engine/context.js";
import { createDirectoryWatchChannel } from "../infra/directory-watch-host.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { captureRetainedNativeWorkerSource } from "../infra/worker-native-lifecycle.js";
import { resolveWorkerPoolSize } from "../infra/worker-pool-sizing.js";
import { createWorkerTaskHost } from "../infra/worker-task-host.js";
import { WorkerTaskError } from "../infra/worker-task-pool.js";
import type { WorkerTaskInput, WorkerTaskOptions } from "../infra/worker-task-pool.types.js";
import { createPluginCaptureOwner } from "../plugins/plugin-capture-native-resource.client.js";
import type { PluginCaptureResourceRoot } from "../plugins/plugin-capture-native-resource.types.js";

export type PreparedModelCatalogWorkerData = {
  databaseEngineSelection?: DatabaseEngineSelection;
  directoryWatchPort?: MessagePort;
  sourceCaptureDirectory: string;
  sourceCaptureManagedRoot?: string;
};

export const GATEWAY_CATALOG_WORKERS = resolveWorkerPoolSize("singleton");
// Leave room for source loaders and overlapping generations without inheriting the host heap budget.
const CATALOG_WORKER_HEAP_LIMITS = { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 32 };

/**
 * Without crash restart, the pool closes itself when its worker fails, exits or times out, even
 * while no task is waiting. It reports its first close so the owner can tell that from its own.
 */
export class CatalogWorkerTaskPool<Input, Output> extends WorkerTaskPoolCore<Input, Output> {
  private captures?: Awaited<ReturnType<typeof createPluginCaptureOwner>>;
  private preparingRoot?: Promise<void>;
  private releasingRoot?: Promise<void>;
  // The pool's input factory settles before prepareWorker consumes this owned root.
  private sourceCapture!: PluginCaptureResourceRoot;

  constructor(
    private readonly env: NodeJS.ProcessEnv,
    validateResult: (result: Output) => void,
    assertCurrent?: () => void,
    private readonly onClose?: (error?: Error) => void,
  ) {
    super(
      {
        workerUrl: resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.preparedModelCatalog),
        workerOptions: { resourceLimits: CATALOG_WORKER_HEAP_LIMITS },
        // Only the inventory owner can replace captured code; idle retirement or crash restart
        // would import a different source generation into an existing publication.
        idleTimeoutMs: 0,
        restartOnError: false,
        prepareWorker: () => {
          assertCurrent?.();
          const capture = this.sourceCapture;
          const watch = createDirectoryWatchChannel();
          return {
            releaseResources: () => {
              // Bun does not always notify the peer port when the worker is terminated.
              watch.close();
              return this.releaseRoot();
            },
            options: {
              workerData: {
                databaseEngineSelection: getDatabaseEngineSelection(),
                directoryWatchPort: watch.port,
                sourceCaptureDirectory: capture.directory,
                sourceCaptureManagedRoot: capture.managedRoot,
              } satisfies PreparedModelCatalogWorkerData,
              transferList: [watch.port],
              // Establish state/config before imported modules observe process.env.
              env,
            },
          };
        },
        validateResult,
      },
      createWorkerTaskHost(undefined, "singleton"),
      {
        close: (error) => this.close(error),
        getSnapshot: () => this.getSnapshot(),
      },
    );
  }

  override run(input: WorkerTaskInput<Input>, options: WorkerTaskOptions<Input>): Promise<Output> {
    const evaluateInput = () => {
      if (this.isClosed) {
        throw new WorkerTaskError("worker task pool closed", "unavailable");
      }
      // SAFETY: WorkerTaskInput defines callable inputs as factories.
      return typeof input === "function" ? (input as () => Input | Promise<Input>)() : input;
    };
    return super.run(() => {
      // Select and post warm inputs in one stack: yielding here lets retirement drop a
      // context after its compact payload was selected but before the worker admits it.
      if (this.sourceCapture) {
        return evaluateInput();
      }
      return (this.preparingRoot ??= (async () => {
        this.captures = await createPluginCaptureOwner(
          captureRetainedNativeWorkerSource({ runtimeGeneration: undefined }),
          {
            native() {
              throw new Error("Catalog execution owns its native captures locally");
            },
          },
        );
        this.sourceCapture = await this.captures.createSource(
          0,
          { stateDir: resolveStateDir(this.env), placement: "state" },
          "openclaw-model-catalog-",
        );
      })().catch((error: unknown) => {
        const failure = toErrorObject(error, "Catalog capture preparation failed");
        // Closing joins this input preparation; report construction failure without self-await.
        void this.close(failure).catch(() => undefined);
        throw failure;
      })).then(evaluateInput);
    }, options);
  }

  private releaseRoot(): Promise<void> {
    return (this.releasingRoot ??= (async () => {
      await this.captures?.releaseSource(0);
    })());
  }

  override close(error?: Error): Promise<void> {
    const first = !this.isClosed;
    const closed = super.close(error);
    if (first) {
      this.onClose?.(error);
    }
    return closed.then(async () => {
      await this.releaseRoot();
      await this.captures?.close();
    });
  }
}
