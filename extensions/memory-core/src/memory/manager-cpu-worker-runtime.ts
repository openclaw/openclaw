import { ensureSqliteLibrarySelected } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import { resolveRuntimeWorkerUrl, WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import type {
  MemoryIndexPreparationInput,
  prepareMemoryIndexChunks,
} from "./manager-index-preparation.js";
import type {
  MemoryKeywordWorkerQuery,
  MemorySearchWorkerInput,
  MemorySearchWorkerOutput,
  MemoryVectorWorkerQuery,
} from "./manager-search.worker.js";
const MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES = 256 * 1024 * 1024;

export type MemoryIndexTask = { kind: "prepare"; input: MemoryIndexPreparationInput };
export type MemoryIndexTaskResult = {
  kind: "prepared";
  value: ReturnType<typeof prepareMemoryIndexChunks>;
};

const retrieval = new WorkerTaskPool<MemorySearchWorkerInput, MemorySearchWorkerOutput>({
  workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.search),
  maxWorkers: 1,
  sharedCompute: true,
});
// Background chunk preparation must not occupy the foreground retrieval worker.
const indexing = new WorkerTaskPool<MemoryIndexTask, MemoryIndexTaskResult>({
  workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.index),
  maxWorkers: 1,
  sharedCompute: true,
  maxPendingBytes: MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES,
});

type MemoryReadTarget = { databasePath: string; agentId: string };

export async function runMemoryIndexState(target: MemoryReadTarget, signal?: AbortSignal) {
  ensureSqliteLibrarySelected();
  const result = await retrieval.run({ ...target, kind: "index-state" }, { signal });
  if (result.kind !== "index-state") {
    throw new Error("Invalid memory index state worker result");
  }
  return result.state;
}

export async function runMemoryRecallMetadata(
  target: MemoryReadTarget,
  query: Omit<
    Extract<MemorySearchWorkerInput, { kind: "recall-metadata" }>,
    keyof MemoryReadTarget | "kind"
  >,
  signal?: AbortSignal,
) {
  ensureSqliteLibrarySelected();
  const result = await retrieval.run(
    { ...target, kind: "recall-metadata", ...query },
    {
      signal,
      inputBytes: query.candidates.reduce(
        (bytes, entry) => bytes + (entry.id.length + entry.path.length + entry.source.length) * 2,
        0,
      ),
    },
  );
  if (result.kind !== "recall-metadata") {
    throw new Error("Invalid memory recall metadata worker result");
  }
  return result;
}

export async function runMemoryCuratedCandidates(
  target: MemoryReadTarget,
  query: Omit<
    Extract<MemorySearchWorkerInput, { kind: "curated" }>,
    keyof MemoryReadTarget | "kind"
  >,
) {
  ensureSqliteLibrarySelected();
  const result = await retrieval.run(
    { ...target, kind: "curated", ...query },
    { inputBytes: query.activeProjectKeys?.reduce((bytes, key) => bytes + key.length * 2, 0) ?? 0 },
  );
  if (result.kind !== "curated") {
    throw new Error("Invalid memory curated candidates worker result");
  }
  return result;
}

export async function runMemoryPresenceInspection(databasePath: string): Promise<boolean> {
  ensureSqliteLibrarySelected();
  const result = await retrieval.run(
    { kind: "presence", databasePath },
    { inputBytes: databasePath.length * 2 },
  );
  if (result.kind !== "presence") {
    throw new Error("Invalid memory presence worker result");
  }
  return result.present;
}

export async function runMemoryKeywordSearch(
  target: MemoryReadTarget,
  query: MemoryKeywordWorkerQuery,
  signal?: AbortSignal,
  includeIndexState = false,
) {
  ensureSqliteLibrarySelected();
  const result = await retrieval.run(
    { ...target, kind: "keyword", query, includeIndexState },
    {
      signal,
      inputBytes:
        2 *
        (query.body.query.length +
          (query.body.rankingQuery?.length ?? 0) +
          query.path.query.length +
          (query.path.exactPathQuery?.length ?? 0)),
    },
  );
  if (result.kind !== "keyword") {
    throw new Error("Invalid memory keyword worker result");
  }
  return result;
}

export async function runMemoryVectorFallback(
  target: MemoryReadTarget,
  query: MemoryVectorWorkerQuery,
  signal?: AbortSignal,
) {
  ensureSqliteLibrarySelected();
  const result = await retrieval.run(
    { ...target, kind: "vector", query },
    {
      signal,
      inputBytes: query.queryVec.length * 8,
    },
  );
  if (result.kind !== "vector") {
    throw new Error("Invalid memory vector worker result");
  }
  return result.rows;
}

export async function prepareMemoryIndexInWorker(input: MemoryIndexPreparationInput) {
  let inputBytes = input.content.length * 2 + (input.entry.lineMap?.length ?? 0) * 8;
  for (const provenance of input.entry.lineProvenance ?? []) {
    inputBytes +=
      32 +
      2 *
        (provenance.originClass.length +
          provenance.sessionKind.length +
          (provenance.supersedesKey?.length ?? 0));
  }
  const result = await indexing.run({ kind: "prepare", input }, { inputBytes });
  if (result.kind !== "prepared") {
    throw new Error("Invalid memory indexing worker result");
  }
  return result.value;
}
