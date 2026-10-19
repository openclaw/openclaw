import { collectNestedErrorCandidates } from "../infra/error-graph-internal.js";
import { resolveRuntimeProcessEntrypointUrl } from "../infra/runtime-process-url.js";
import { captureRuntimeWorkerSource } from "../infra/runtime-worker-generation.js";
import { readSqliteInspectionBudget } from "../infra/sqlite-readonly-worker.js";
import { createSqliteWorkerTransferCollector } from "../infra/sqlite-worker-transfer.js";
import { createOwnedWorkerTaskPool, WorkerTaskError } from "../infra/worker-task-pool.js";
import { resolveGlobalMap } from "../shared/global-singleton.js";
import type {
  PersistedPluginModelCatalog,
  PluginModelCatalogReadInput,
  PluginModelCatalogReadResult,
} from "./plugin-model-catalog-read.types.js";

type CatalogReadPool = ReturnType<
  typeof createOwnedWorkerTaskPool<PluginModelCatalogReadInput, PluginModelCatalogReadResult>
>;

class PluginModelCatalogInputError extends WorkerTaskError {
  readonly operation = "catalog.read";
  readonly field: string;

  constructor(input: PluginModelCatalogReadInput, cause: unknown) {
    let field = "input";
    // Inspect only after transport rejection; successful requests pay no extra clone cost.
    for (const [key, value] of Object.entries(input)) {
      try {
        structuredClone(value);
      } catch {
        field = `input.${key}`;
        break;
      }
    }
    super(`Cannot serialize catalog.read request field ${field}`, "failed", { cause });
    this.name = "PluginModelCatalogInputError";
    this.field = field;
  }
}

function catalogReadPool(): CatalogReadPool {
  const source = captureRuntimeWorkerSource(
    resolveRuntimeProcessEntrypointUrl("pluginModelCatalogRead"),
  );
  const pools = resolveGlobalMap<string, CatalogReadPool>(
    Symbol.for("openclaw.pluginModelCatalogReadPools"),
    async (retainedPools) => {
      await Promise.all([...retainedPools.values()].map((pool) => pool.close()));
      retainedPools.clear();
    },
  );
  const key = source.moduleUrl.href;
  let pool = pools.get(key);
  if (!pool) {
    pool = createOwnedWorkerTaskPool<PluginModelCatalogReadInput, PluginModelCatalogReadResult>(
      {
        workerUrl: source.moduleUrl,
        workerOptions: { workerData: { pluginCatalogRead: true } },
        maxWorkers: 1,
      },
      { databaseAccess: "read-only" },
    );
    pools.set(key, pool);
    const retained = pool;
    source.runtimeGeneration?.retain(pool, async () => {
      await retained.close();
      pools.delete(key);
    });
  }
  return pool;
}

/** Task workers receive owner publications, so admission survives native reader close. */
export async function readPluginModelCatalogsInWorker(
  input: PluginModelCatalogReadInput,
  signal: AbortSignal,
): Promise<PersistedPluginModelCatalog[]> {
  const { timeoutMs } = readSqliteInspectionBudget("plugin catalog read", input.path);
  let catalogs: PersistedPluginModelCatalog[] = [];
  const transfer = createSqliteWorkerTransferCollector("catalogs", (value) => {
    // SAFETY: The private catalog worker serializes this typed result; framing validates transport.
    catalogs = value as PersistedPluginModelCatalog[];
  });
  const result = await catalogReadPool()
    .run(input, {
      signal,
      timeoutMs,
      onRequest: async (value) => {
        transfer.accept(value);
        return { input: null, timeoutMs };
      },
    })
    .catch((error: unknown) => {
      if (
        collectNestedErrorCandidates(error).some(
          (cause) => cause instanceof Error && cause.name === "DataCloneError",
        )
      ) {
        throw new PluginModelCatalogInputError(input, error);
      }
      throw error;
    });
  if (result) {
    throw new Error(result.error);
  }
  return catalogs;
}
