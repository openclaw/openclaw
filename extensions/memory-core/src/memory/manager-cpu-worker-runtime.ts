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

const retrieval = new WorkerTaskPool<MemorySearchWorkerInput, MemorySearchWorkerOutput>({
  workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.search),
  maxWorkers: 1,
  sharedCompute: true,
});
// Background chunk preparation must not occupy the foreground retrieval worker.
const indexing = new WorkerTaskPool<
  MemoryIndexPreparationInput,
  ReturnType<typeof prepareMemoryIndexChunks>
>({
  workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.index),
  maxWorkers: 1,
  sharedCompute: true,
});

type MemoryReadTarget = { databasePath: string; agentId: string };

export async function runMemoryKeywordSearch(
  target: MemoryReadTarget,
  query: MemoryKeywordWorkerQuery,
  signal?: AbortSignal,
) {
  ensureSqliteLibrarySelected();
  const result = await retrieval.run(
    { ...target, kind: "keyword", query },
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

export function prepareMemoryIndexInWorker(input: MemoryIndexPreparationInput) {
  let inputBytes = input.content.length * 2 + (input.entry.lineMap?.length ?? 0) * 8;
  for (const provenance of input.entry.lineProvenance ?? []) {
    inputBytes +=
      32 +
      2 *
        (provenance.originClass.length +
          provenance.sessionKind.length +
          (provenance.supersedesKey?.length ?? 0));
  }
  return indexing.run(input, { inputBytes });
}
