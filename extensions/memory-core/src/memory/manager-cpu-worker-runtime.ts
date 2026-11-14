import { toErrorObject } from "openclaw/plugin-sdk/error-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { ensureSqliteLibrarySelected } from "openclaw/plugin-sdk/memory-core-host-engine-knn";
import type {
  SessionEntryStream,
  SessionEntrySummary,
} from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { DatabaseSearchCapabilityUnavailableError } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import type { readTranscriptStatsBatchReadOnlySync } from "openclaw/plugin-sdk/memory-core-host-transcript-stats";
import { resolveRuntimeWorkerUrl, WorkerTaskPool } from "openclaw/plugin-sdk/process-runtime";
import type {
  MemoryOriginReadFilters,
  MemoryOriginReadInput,
} from "../memory-entry-origins-task.js";
import type { ForgetIndexReadInput } from "../memory-forget-index-task.js";
import type { IndexedMemoryChunk } from "./manager-chunk-writer.js";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import type {
  MemoryIndexPreparationInput,
  prepareMemoryIndexChunks,
} from "./manager-index-preparation.js";
import type { MemoryIndexReadCommand, MemoryIndexReadOperations } from "./manager-index-read.js";
import type { MemoryKeywordWorkerQuery, MemoryVectorWorkerQuery } from "./manager-search-types.js";
import type { MemorySearchWorkerInput, MemorySearchWorkerOutput } from "./manager-search.worker.js";
import {
  sessionIndexPages,
  type SessionIndexPage,
  type SessionIndexPreparation,
  type SessionIndexProgress,
} from "./manager-session-index-preparation.js";
import type { MemoryStatusQuery } from "./manager-status-state.js";
const MEMORY_INDEX_WORKER_INPUT_LIMIT_BYTES = 256 * 1024 * 1024;
// Session preparation admits one framed page at a time.
const SESSION_INDEX_PAGE_INPUT_BYTES = 64 * 1024;

type MemoryTranscriptStatsScope = Omit<
  Parameters<typeof readTranscriptStatsBatchReadOnlySync>[0][number],
  "env"
>;
export type MemoryIndexTask =
  | { kind: "prepare"; input: MemoryIndexPreparationInput }
  | { kind: "prepare-session"; input: SessionIndexPreparation }
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
// Session chunking runs in lockstep with its export, whose transcript worker already holds the
// pipeline's shared compute permit while it waits for each page to be taken. A second permit would
// deadlock on one-permit hosts, so this stage runs under the export's permit. One worker bounds it.
const sessionIndexing = new WorkerTaskPool<MemoryIndexTask, MemoryIndexTaskResult>({
  workerUrl: resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.index),
  workerClass: "compute",
  maxWorkers: 1,
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

export async function runMemoryDatabaseAdmission(target: MemoryReadTarget) {
  const result = await runRetrieval({ ...target, kind: "admission" }, {}, "database admission");
  return result.admission;
}

export async function runMemoryStatus(target: MemoryReadTarget, query: MemoryStatusQuery) {
  const result = await runRetrieval({ ...target, kind: "status", query }, {}, "status");
  return result.snapshot;
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

export async function runMemoryIndexRead<Command extends MemoryIndexReadCommand>(
  target: MemoryReadTarget,
  command: Command,
): Promise<MemoryIndexReadOperations[Command["type"]]["output"]> {
  const result = await runRetrieval(
    { ...target, kind: "index-read", command },
    { inputBytes: JSON.stringify(command).length * 2 },
    "index read",
  );
  if (result.read.type !== command.type) {
    throw new Error("Memory index reader returned another operation");
  }
  // SAFETY: The paired worker returned the result tagged with this command's type.
  return result.read.value as MemoryIndexReadOperations[Command["type"]]["output"];
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

export async function runMemoryPresenceInspection(
  databasePath: string,
  agentId?: string,
): Promise<boolean> {
  const result = await runRetrieval(
    { kind: "presence", databasePath, agentId },
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
      inputBytes:
        2 * (query.body.query.length + query.path.query.length) +
        (query.body.sourceFilter.excludedSessionPaths?.reduce(
          (bytes, path) => bytes + path.length * 2,
          0,
        ) ?? 0) +
        (query.path.sourceFilter.excludedSessionPaths?.reduce(
          (bytes, path) => bytes + path.length * 2,
          0,
        ) ?? 0),
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
        (query.candidateIds?.reduce((bytes, id) => bytes + id.length * 2, 0) ?? 0) +
        (query.sourceFilter.excludedSessionPaths?.reduce(
          (bytes, path) => bytes + path.length * 2,
          0,
        ) ?? 0),
    },
    "vector",
  );
  if (result.capabilityError) {
    throw new DatabaseSearchCapabilityUnavailableError(
      result.capabilityError.capability,
      result.capabilityError.message,
    );
  }
  return result.rows;
}

export async function prepareMemoryIndexInWorker(input: MemoryIndexPreparationInput) {
  if (input.source === "sessions") {
    throw new Error("Session sources stream through prepareSessionIndexInWorker");
  }
  const result = await indexing.run(
    { kind: "prepare", input },
    { inputBytes: input.content.length * 2 },
  );
  if (result.kind !== "prepared") {
    throw new Error("Invalid memory indexing worker result");
  }
  return result.value;
}

/** Hands export pages to the index worker one at a time; the producer waits until each is taken. */
class SessionIndexPageHandoff {
  private readonly pages: SessionIndexPage[] = [];
  private onAvailable: (() => void) | undefined;
  private onTaken: { resolve: () => void; reject: (error: unknown) => void } | undefined;
  private end: { error?: Error } | undefined;
  private aborted: Error | undefined;

  offer(pages: SessionIndexPage[]): Promise<void> {
    if (this.aborted) {
      return Promise.reject(this.aborted);
    }
    if (pages.length === 0) {
      return Promise.resolve();
    }
    this.pages.push(...pages);
    this.wake();
    return new Promise((resolve, reject) => {
      this.onTaken = { resolve, reject };
    });
  }

  close(error?: unknown) {
    this.end = error === undefined ? {} : { error: toErrorObject(error, "Session export failed") };
    this.wake();
  }

  /** The consumer failed; release a waiting producer. */
  abort(error: unknown) {
    this.aborted = toErrorObject(error, "Session indexing failed");
    this.pages.length = 0;
    this.onTaken?.reject(this.aborted);
    this.onTaken = undefined;
  }

  async take(): Promise<SessionIndexPage | undefined> {
    for (;;) {
      const page = this.pages.shift();
      if (page) {
        if (this.pages.length === 0) {
          this.onTaken?.resolve();
          this.onTaken = undefined;
        }
        return page;
      }
      if (this.end) {
        if (this.end.error) {
          throw this.end.error;
        }
        return undefined;
      }
      await new Promise<void>((resolve) => {
        this.onAvailable = resolve;
      });
    }
  }

  private wake() {
    const wake = this.onAvailable;
    this.onAvailable = undefined;
    wake?.();
  }
}

/**
 * Chunks a session while its export streams: neither the export nor the index worker holds more
 * than one page of transcript text. Returns null when the transcript disappeared.
 */
export async function prepareSessionIndexInWorker(
  input: SessionIndexPreparation,
  streamExport: (stream: SessionEntryStream) => Promise<SessionEntrySummary | null>,
): Promise<{ chunks: IndexedMemoryChunk[] } | null> {
  const chunks: IndexedMemoryChunk[] = [];
  const handoff = new SessionIndexPageHandoff();
  let indexed: Promise<void> | undefined;
  // Dispatch the chunker only once its export runs, so a queued chunker never waits on an export
  // that is itself queued behind another chunker.
  const startIndexing = () => {
    if (!indexed) {
      indexed = chunkSessionPages(input, handoff, chunks).catch((error: unknown) => {
        handoff.abort(error);
        throw error;
      });
      // Observed below; a failure must not surface as unhandled while the export settles.
      indexed.catch(() => undefined);
    }
    return indexed;
  };
  const summary = await streamExport({
    onPage: (page) => {
      void startIndexing();
      return handoff.offer(sessionIndexPages(page));
    },
    onReset: () => {
      void startIndexing();
      return handoff.offer([{ lines: [], done: false, reset: true }]);
    },
  }).then(
    (exported) => {
      handoff.close();
      return exported;
    },
    async (error: unknown) => {
      handoff.close(error);
      // A chunker failure aborts the export; report that cause.
      await indexed;
      throw error;
    },
  );
  if (!summary && !indexed) {
    return null;
  }
  await startIndexing();
  return summary ? { chunks } : null;
}

async function chunkSessionPages(
  input: SessionIndexPreparation,
  handoff: SessionIndexPageHandoff,
  chunks: IndexedMemoryChunk[],
) {
  const result = await sessionIndexing.run(
    { kind: "prepare-session", input },
    {
      inputBytes: SESSION_INDEX_PAGE_INPUT_BYTES,
      onRequest: async (value) => {
        // The worker exchanges a completed chunk batch for the next export page.
        // SAFETY: only the paired prepare-session worker sends requests on this task.
        const progress = value as SessionIndexProgress;
        for (const chunk of progress.chunks) {
          chunks.push(chunk);
        }
        const page = (await handoff.take()) ?? { lines: [], done: true };
        if (page.reset) {
          chunks.length = 0;
        }
        return { input: page, timeoutMs: 60_000 };
      },
    },
  );
  if (result.kind !== "prepared") {
    throw new Error("Invalid memory indexing worker result");
  }
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
