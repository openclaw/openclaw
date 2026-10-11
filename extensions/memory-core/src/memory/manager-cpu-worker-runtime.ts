import { resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { ensureSqliteLibrarySelected } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import type { readTranscriptStatsBatchReadOnlySync } from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { resolveRuntimeWorkerUrl, WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import type {
  MemoryOriginReadFilters,
  MemoryOriginReadInput,
} from "../memory-entry-origins-task.js";
import type { ForgetIndexReadInput } from "../memory-forget-index-task.js";
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
import { assertMemoryShadowIdentity, readMemoryShadowIdentity } from "./manager-shadow-task.js";
import type { loadMemorySourceFileState } from "./manager-source-state.js";
const MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES = 256 * 1024 * 1024;

type MemoryTranscriptStatsScope = Omit<
  Parameters<typeof readTranscriptStatsBatchReadOnlySync>[0][number],
  "env"
>;
export type MemoryIndexTask =
  | { kind: "prepare"; input: MemoryIndexPreparationInput }
  | {
      kind: "transcript-stats";
      scopes: readonly MemoryTranscriptStatsScope[];
      env: { OPENCLAW_STATE_DIR: string; OPENCLAW_SUPERVISOR_MODE?: string };
    };
export type MemoryIndexTaskResult =
  | { kind: "prepared"; value: ReturnType<typeof prepareMemoryIndexChunks> }
  | { kind: "transcript-stats"; stats: ReturnType<typeof readTranscriptStatsBatchReadOnlySync> };

const retrieval = new WorkerTaskPool<MemorySearchWorkerInput, MemorySearchWorkerOutput>({
  workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.search),
  workerClass: "reader",
  sharedCompute: true,
});
// Background chunk preparation must not occupy the foreground retrieval worker.
const indexing = new WorkerTaskPool<MemoryIndexTask, MemoryIndexTaskResult>({
  workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.index),
  workerClass: "compute",
  sharedCompute: true,
  maxPendingBytes: MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES,
});

type MemoryReadTarget = { databasePath: string; agentId: string };

function hasResultKind<Kind extends MemorySearchWorkerOutput["kind"]>(
  result: MemorySearchWorkerOutput,
  kind: Kind,
): result is Extract<MemorySearchWorkerOutput, { kind: Kind }> {
  return result.kind === kind;
}

async function runRetrieval<Kind extends MemorySearchWorkerInput["kind"]>(
  request: MemorySearchWorkerInput & { kind: Kind },
  options: Parameters<typeof retrieval.run>[1],
  description: string,
) {
  ensureSqliteLibrarySelected();
  const result = await retrieval.run(request, options);
  if (!hasResultKind(result, request.kind)) {
    throw new Error(`Invalid memory ${description} worker result`);
  }
  return result;
}

export async function runMemoryForgetIndexPlan(request: ForgetIndexReadInput) {
  let inputBytes =
    2 * (request.agentId.length + request.databasePath.length + request.stateDir.length);
  for (const values of [
    request.changedPaths,
    request.removedPaths,
    request.sessionIds,
    request.excludedSessionIds,
    request.entryKeys,
    request.corpusSnippets,
  ]) {
    for (const value of values) {
      inputBytes += value.length * 2;
    }
  }
  const result = await runRetrieval(request, { inputBytes }, "Forget index plan");
  return result.plan;
}

export async function runMemoryOriginRead<Kind extends MemoryOriginReadInput["kind"]>(
  request: MemoryOriginReadInput & MemoryOriginReadFilters & { kind: Kind },
) {
  return runRetrieval<Kind>(
    request,
    {
      inputBytes:
        2 *
        (request.agentId.length +
          request.databasePath.length +
          request.stateDir.length +
          (request.entryKeys?.reduce((bytes, key) => bytes + key.length, 0) ?? 0) +
          (request.sessionIds?.reduce((bytes, key) => bytes + key.length, 0) ?? 0)),
    },
    {
      "origin-rows": "origin rows",
      "session-tombstones": "tombstone rows",
      "origin-exists": "origin existence",
    }[request.kind],
  );
}

export async function prewarmMemorySearchWorker(): Promise<void> {
  ensureSqliteLibrarySelected();
  await retrieval.run({ kind: "prewarm" }, {});
}

export async function runMemoryIndexState(target: MemoryReadTarget, signal?: AbortSignal) {
  const result = await runRetrieval({ ...target, kind: "index-state" }, { signal }, "index state");
  return result.state;
}

export async function runMemoryDatabaseFacts(databasePath: string, agentId: string) {
  const result = await runRetrieval(
    { databasePath, agentId, kind: "index-facts" },
    {},
    "index facts",
  );
  return result.facts;
}

export async function runMemoryVectorLoad(
  target: { agentId?: string; path?: string } | undefined,
  extensionPath?: string,
) {
  if (!target?.agentId || !target.path) {
    throw new Error("Memory vector inspection requires its captured database target");
  }
  const result = await runRetrieval(
    { agentId: target.agentId, databasePath: target.path, kind: "vector-load", extensionPath },
    {},
    "vector capability",
  );
  const loaded = result.result;
  if (!loaded.ok || !loaded.extensionPath) {
    throw new Error(loaded.error ?? "unknown sqlite-vec load error");
  }
  return { extensionPath: loaded.extensionPath, retiredLegacy: false };
}

export async function runMemoryRecallMetadata(
  target: MemoryReadTarget,
  query: Omit<
    Extract<MemorySearchWorkerInput, { kind: "recall-metadata" }>,
    keyof MemoryReadTarget | "kind"
  >,
  signal?: AbortSignal,
) {
  return runRetrieval(
    { ...target, kind: "recall-metadata", ...query },
    {
      signal,
      inputBytes: query.candidates.reduce(
        (bytes, entry) => bytes + (entry.id.length + entry.path.length + entry.source.length) * 2,
        0,
      ),
    },
    "recall metadata",
  );
}

export async function runMemorySourceState(
  target: MemoryReadTarget,
  query: Omit<Parameters<typeof loadMemorySourceFileState>[0], "db">,
) {
  const fileIdentity = readMemoryShadowIdentity(target.databasePath);
  const result = await runRetrieval(
    { ...target, kind: "source-state", query, fileIdentity },
    { inputBytes: query.paths?.reduce((bytes, path) => bytes + path.length * 2, 0) ?? 0 },
    "source state",
  );
  assertMemoryShadowIdentity(target.databasePath, fileIdentity);
  return result.rows;
}

export async function runMemoryCuratedCandidates(
  target: MemoryReadTarget,
  query: Omit<
    Extract<MemorySearchWorkerInput, { kind: "curated" }>,
    keyof MemoryReadTarget | "kind"
  >,
) {
  return runRetrieval(
    { ...target, kind: "curated", ...query },
    { inputBytes: query.activeProjectKeys?.reduce((bytes, key) => bytes + key.length * 2, 0) ?? 0 },
    "curated candidates",
  );
}

export async function runMemoryPresenceInspection(databasePath: string): Promise<boolean> {
  const result = await runRetrieval(
    { kind: "presence", databasePath },
    { inputBytes: databasePath.length * 2 },
    "presence",
  );
  return result.present;
}

export async function runMemoryKeywordSearch(
  target: MemoryReadTarget,
  query: MemoryKeywordWorkerQuery,
  signal?: AbortSignal,
  includeIndexState = false,
) {
  return runRetrieval(
    { ...target, kind: "keyword", query, includeIndexState },
    {
      signal,
      inputBytes: 2 * (query.body.query.length + query.path.query.length),
    },
    "keyword",
  );
}

export async function runMemoryVectorFallback(
  target: MemoryReadTarget,
  query: MemoryVectorWorkerQuery,
  signal?: AbortSignal,
) {
  const result = await runRetrieval(
    { ...target, kind: "vector", query },
    {
      signal,
      inputBytes:
        query.queryVec.length * 8 +
        (query.candidateIds?.reduce((bytes, id) => bytes + id.length * 2, 0) ?? 0),
    },
    "vector",
  );
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

/** Startup scans use the background indexing pool under the shared compute limit. */
export async function readMemoryTranscriptStatsInWorker(
  scopes: readonly MemoryTranscriptStatsScope[],
) {
  if (scopes.length === 0) {
    return [];
  }
  ensureSqliteLibrarySelected();
  const env = {
    OPENCLAW_STATE_DIR: resolveStateDir(),
    OPENCLAW_SUPERVISOR_MODE: process.env.OPENCLAW_SUPERVISOR_MODE,
  };
  const result = await indexing.run(
    { kind: "transcript-stats", scopes, env },
    { inputBytes: 2 * (JSON.stringify(scopes).length + JSON.stringify(env).length) },
  );
  if (result.kind !== "transcript-stats") {
    throw new Error("Invalid memory transcript stats worker result");
  }
  return result.stats;
}
