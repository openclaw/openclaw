import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import type { EmbeddingInput } from "openclaw/plugin-sdk/embedding-providers";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { registerEmbeddingProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-runtime-mocks.js";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { resetMemoryDatabase } from "./manager-db.js";
import { memoryPublicationFaultEntrypoint } from "./manager-publication-fault-entrypoint.test-support.js";
import {
  observePublishedReservations,
  observePublishedSql,
  reservePublishedWriter,
} from "./manager-publication-observer.test-support.js";
import { waitForMemoryReindexLock } from "./manager-reindex-lock.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

function queryRows(db: DatabaseSync, sql: string, ...bindings: SQLInputValue[]) {
  return db.prepare(sql).all(...bindings);
}
function queryRow(db: DatabaseSync, sql: string) {
  return db.prepare(sql).get();
}

function publishedCacheRows(db: DatabaseSync) {
  return queryRows(db, "SELECT * FROM memory_embedding_cache ORDER BY hash");
}
function chunkTexts(db: DatabaseSync) {
  return queryRows(db, "SELECT text FROM memory_index_chunks");
}

type CacheIdentity = { provider: string; model: string; provider_key: string };

type SyncArchiveParams = { needsFullReindex: boolean; targetArchiveFiles?: string[] };

type ReindexHarness = {
  sync: (params: { reason?: string; force?: boolean }) => Promise<void>;
  syncArchiveFiles: (params: SyncArchiveParams) => Promise<unknown>;
  db: DatabaseSync;
  cache: { enabled: boolean; maxEntries?: number };
  database: MemoryIndexDatabase;
  providerKey: string | null;
  provider: EmbeddingProvider | null;
  dirty: boolean;
  memoryFullRetryDirty: boolean;
  sessionsDirty: boolean;
  sessionsFullRetryDirty: boolean;
  sessionsDirtyFiles: Set<string>;
};

describe("memory manager reindex recovery", () => {
  let fixtureRoot = "";
  let workspaceDir = "";
  let memoryDir = "";
  let manager: MemoryIndexManager | null = null;
  let embeddingCalls: unknown[][] = [];
  let onEmbedBatch: ((inputs: Array<string | EmbeddingInput>) => void) | undefined;
  let batchEmbeddingCalls: string[][] = [];

  function createProvider(id: string): EmbeddingProvider {
    return {
      id,
      model: "mock-embed",
      maxInputTokens: 8192,
      embed: async () => [0, 1, 0],
      embedBatch: async (inputs) => {
        if (id === "openai") {
          embeddingCalls.push(inputs);
          onEmbedBatch?.(inputs);
        }
        return inputs.map(() => [0, 1, 0]);
      },
    };
  }

  beforeEach(async () => {
    embeddingCalls = [];
    onEmbedBatch = undefined;
    batchEmbeddingCalls = [];
    // Register the fixture at the same boundary used by config and provider creation.
    registerEmbeddingProvider({
      id: "openai",
      transport: "remote",
      create: async () => ({ provider: createProvider("openai") }),
    });
    for (const id of ["batch-test", "batch-wide-test"] as const) {
      registerEmbeddingProvider({
        id,
        transport: "remote",
        create: async () => ({
          provider: createProvider(id),
          runtime: {
            id,
            ...(id === "batch-wide-test" ? { sourceWideBatchEmbed: true } : {}),
            batchEmbed: async (batch: { chunks: Array<{ text: string }> }) => {
              batchEmbeddingCalls.push(batch.chunks.map((chunk) => chunk.text));
              return batch.chunks.map(() => [0, 1, 0]);
            },
          },
        }),
      });
    }
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-reindex-recovery-"));
    workspaceDir = path.join(fixtureRoot, "workspace");
    memoryDir = path.join(workspaceDir, "memory");
    await fs.mkdir(memoryDir, { recursive: true });
    vi.stubEnv("OPENCLAW_STATE_DIR", path.join(fixtureRoot, "state"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (manager) {
      await manager.close();
      manager = null;
    }
    const { closeAllMemorySearchManagers } = await import("./index.js");
    await closeAllMemorySearchManagers();
    // The agent close releases its leases through shared state and reopens it, so the
    // shared handle is released second; otherwise Windows fails the removal with EBUSY.
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    clearRuntimeConfigSnapshot();
    resetPluginStateStoreForTests();
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  function createCfg(params: {
    provider?: string;
    sources?: Array<"memory" | "sessions">;
    cacheEnabled?: boolean;
    batchEnabled?: boolean;
  }): OpenClawConfig {
    return isolateMemoryManagerTestConfig({
      memory: {
        search: {
          provider: params.provider ?? "openai",
          model: "mock-embed",
          store: { vector: {} },
          remote: params.batchEnabled ? { batch: { enabled: true } } : undefined,
          cache: { enabled: params.cacheEnabled ?? false },
          sources: params.sources,
          rememberAcrossConversations: params.sources?.includes("sessions") ?? false,
        },
      },
      agents: { defaults: { workspace: workspaceDir }, entries: { main: {} } },
    });
  }

  async function openManager(cfg: OpenClawConfig): Promise<MemoryIndexManager> {
    setRuntimeConfigSnapshot(cfg);
    const { getMemorySearchManager } = await import("./index.js");
    const result = await getMemorySearchManager({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg,
      agentId: "main",
    });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    manager = result.manager as unknown as MemoryIndexManager;
    return manager;
  }

  it("retries both sources without force after a late shadow failure", async () => {
    const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
    await fs.mkdir(sessionsDir, { recursive: true });
    const transcript = path.join(sessionsDir, "retry.jsonl.deleted.2026-09-01T00-00-00.000Z");
    const writeSources = async (version: string) => {
      await fs.writeFile(path.join(memoryDir, "alpha.md"), `${version} memory`);
      await fs.writeFile(
        transcript,
        `${JSON.stringify({ type: "message", message: { role: "user", content: `${version} session` } })}\n`,
      );
    };
    await writeSources("published");
    const memoryManager = await openManager(
      createCfg({ provider: "none", sources: ["memory", "sessions"] }),
    );
    const harness = memoryManager as unknown as ReindexHarness;
    const rows = harness.db.prepare("SELECT source, text FROM memory_index_chunks ORDER BY source");
    await memoryManager.sync({ force: true });
    expect(rows.all()).toEqual([
      { source: "memory", text: "published memory" },
      { source: "sessions", text: "User: published session" },
    ]);

    await writeSources("replacement");
    harness.sessionsDirty = true;
    harness.sessionsDirtyFiles.add(transcript);
    vi.spyOn(MemoryIndexDatabase.prototype, "writeMetadata").mockImplementationOnce(() => {
      throw new Error("late reindex failure");
    });
    await expect(memoryManager.sync({ force: true })).rejects.toThrow("late reindex failure");
    expect(harness).toMatchObject({
      dirty: true,
      memoryFullRetryDirty: true,
      sessionsDirty: true,
      sessionsFullRetryDirty: true,
    });
    expect([...harness.sessionsDirtyFiles]).toEqual([transcript]);
    expect(rows.all()).toEqual([
      { source: "memory", text: "published memory" },
      { source: "sessions", text: "User: published session" },
    ]);

    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 30_000);
    await memoryManager.sync();
    expect(rows.all()).toEqual([
      { source: "memory", text: "replacement memory" },
      { source: "sessions", text: "User: replacement session" },
    ]);
    expect(harness).toMatchObject({
      dirty: false,
      memoryFullRetryDirty: false,
      sessionsDirty: false,
      sessionsFullRetryDirty: false,
    });
    expect(harness.sessionsDirtyFiles.size).toBe(0);
  });

  it.for(
    [true, false].flatMap((cacheEnabled) => [
      {
        cacheEnabled,
        invalid: [0, Number.NaN, 0],
        condition: "non-finite or non-numeric coordinate",
      },
      { cacheEnabled, invalid: [], condition: "empty embedding" },
    ]),
  )(
    "rejects $condition with cache enabled=$cacheEnabled",
    async ({ cacheEnabled, invalid, condition }) => {
      await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
      const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled }));
      await memoryManager.sync({ reason: "cli", force: true });
      await fs.writeFile(
        path.join(memoryDir, "alpha.md"),
        Array.from(
          { length: 80 },
          (_, index) => `Fact ${index}: keep independent reusable memory content.`,
        ).join("\n"),
      );
      // SAFETY: the fixture owns this manager and its registered embedding provider.
      const harness = memoryManager as unknown as ReindexHarness;
      if (!harness.provider) {
        throw new Error("fixture provider missing");
      }
      const cachedBefore = queryRows(harness.db, "SELECT hash FROM memory_embedding_cache");
      const embed = vi
        .spyOn(harness.provider, "embedBatch")
        .mockImplementationOnce(async (inputs) => {
          expect(inputs.length).toBeGreaterThan(1);
          return inputs.map((_, index) => (index === 0 ? [0, 1, 0] : invalid));
        });
      await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
        new RegExp(
          `openai embeddings failed \\(model: mock-embed, batch size: \\d+\\): ${condition} at position 1`,
        ),
      );
      expect(queryRows(harness.db, "SELECT hash FROM memory_embedding_cache")).toEqual(
        cachedBefore,
      );
      expect(chunkTexts(harness.db)).toEqual([{ text: "published alpha" }]);
      await memoryManager.sync({ reason: "cli", force: true });
      expect(embed).toHaveBeenCalledTimes(2);
      const cached = queryRows(harness.db, "SELECT hash FROM memory_embedding_cache");
      expect(cached.length > 0).toBe(cacheEnabled);
    },
  );

  it("waits for the published writer before clearing conflicting dimensions and recovers", async () => {
    const cfg = createCfg({ sources: ["memory"], cacheEnabled: true });
    const memoryManager = await openManager(cfg);
    const harness = memoryManager as unknown as ReindexHarness;
    const queued = createDeferred<void>();
    let reservation: Awaited<ReturnType<typeof reservePublishedWriter>> | undefined;
    observePublishedReservations(harness.db, () => {
      if (reservation) {
        queued.resolve();
      }
    });
    await memoryManager.sync({ reason: "cli", force: true });
    if (!harness.provider) {
      throw new Error("fixture provider missing");
    }
    await fs.writeFile(
      path.join(memoryDir, "large.md"),
      `${"first ".repeat(3500)}\n${"second ".repeat(3500)}`,
    );
    openOpenClawAgentDatabase({ agentId: "main" })
      .db.prepare(`INSERT INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES ('unrelated', 'unrelated', 'unrelated', 'keep', ?, 2, 1)`)
      .run(encodeMemoryEmbedding([1, 0]));
    const embed = vi
      .spyOn(harness.provider, "embedBatch")
      .mockImplementationOnce(async (inputs) => inputs.map(() => [0, 1]))
      .mockImplementationOnce(async (inputs) => {
        reservation = await reservePublishedWriter();
        return inputs.map(() => [0, 1, 0]);
      });
    const sync = memoryManager.sync({ reason: "cli", force: true });
    void sync.catch(() => undefined);
    try {
      await Promise.race([queued.promise, sync]);
      expect(
        queryRows(harness.db, "SELECT hash FROM memory_embedding_cache WHERE provider = 'openai'")
          .length,
      ).toBeGreaterThan(0);
      reservation?.release();
      await reservation?.done;
      await expect(sync).rejects.toThrow(
        /openai embeddings failed \(model: mock-embed, batch size: \d+\): expected 2 dimensions, got 3 at position 0/,
      );
    } finally {
      reservation?.release();
      await reservation?.done;
      await sync.catch(() => undefined);
    }
    expect(embed.mock.calls.length).toBeGreaterThan(1);
    expect(queryRows(harness.db, "SELECT provider FROM memory_embedding_cache")).toEqual([
      { provider: "unrelated" },
    ]);
    await memoryManager.close();
    manager = null;
    const reopened = await openManager(cfg);
    await expect(reopened.sync({ reason: "cli", force: true })).resolves.toBeUndefined();
    expect(
      queryRows(
        (reopened as unknown as ReindexHarness).db,
        "SELECT DISTINCT dims FROM memory_embedding_cache WHERE provider = 'openai'",
      ),
    ).toEqual([{ dims: 3 }]);
  });

  it.each(["committed clear reply", "publication admission"] as const)(
    "does not resurrect an ambiguous cache when its %s fails",
    async (failurePoint) => {
      const memoryManager = await openManager(
        createCfg({ sources: ["memory"], cacheEnabled: true }),
      );
      const harness = memoryManager as unknown as ReindexHarness;
      const publishedDb = harness.db;
      const cached = createDeferred<void>();
      const allProvidersEntered = createDeferred<void>();
      const releaseConflict = createDeferred<void>();
      const releaseLate = createDeferred<void>();
      const clearFailed = createDeferred<unknown>();
      const admissionError = new Error("injected cache clear admission refusal");
      const errorMessage =
        failurePoint === "committed clear reply"
          ? "injected committed cache clear reply failure"
          : admissionError.message;
      let conflictReturned = false;
      let admissionRefused = false;
      const cacheRows = () =>
        queryRows(publishedDb, "SELECT hash, dims FROM memory_embedding_cache ORDER BY hash");
      const fullCacheRows = () => publishedCacheRows(publishedDb);
      const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
      vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2").mockImplementation(
        async (...args) => {
          const [options, source, workerInput] = args;
          if (
            options.path !== publishedDb.location() ||
            workerInput.moduleUrl.href !==
              resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication).href
          ) {
            return await open(...args);
          }
          const worker =
            failurePoint === "committed clear reply"
              ? await open(options, source, {
                  ...workerInput,
                  moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
                  input: { kind: "cache-clear-result", publication: workerInput.input },
                })
              : await open(...args);
          const execute = worker.execute.bind(worker);
          vi.spyOn(worker, "execute").mockImplementation(async (...executeArgs) => {
            try {
              if (
                failurePoint === "publication admission" &&
                conflictReturned &&
                !admissionRefused
              ) {
                admissionRefused = true;
                throw admissionError;
              }
              const result = await execute(...executeArgs);
              if (cacheRows().some((row) => row.dims === 2)) {
                cached.resolve();
              }
              return result;
            } catch (error) {
              clearFailed.resolve(error);
              throw error;
            }
          });
          return worker;
        },
      );
      await memoryManager.sync({ reason: "baseline", force: true });
      const provider = harness.provider;
      if (!provider) {
        throw new Error("fixture provider missing after initialization");
      }
      const sources = [
        ["good", "First reusable violet memory."],
        ["conflict", "Conflicting reusable amber memory."],
        ["late", "Later reusable cobalt memory."],
      ] as const;
      for (const [name, text] of sources) {
        await fs.writeFile(path.join(memoryDir, `${name}.md`), text);
      }
      const calls: string[] = [];
      const embed = vi.spyOn(provider, "embedBatch").mockImplementation(async (inputs) => {
        const source = sources.find(([, text]) =>
          inputs.some((input) => typeof input === "string" && input.includes(text)),
        );
        if (!source) {
          throw new Error("Unexpected embedding input in cache-clear fixture");
        }
        calls.push(source[0]);
        if (calls.length === 3) {
          allProvidersEntered.resolve();
        }
        if (source[0] === "conflict") {
          await releaseConflict.promise;
          conflictReturned = true;
          return inputs.map(() => [0, 1, 0]);
        }
        if (source[0] === "late") {
          await releaseLate.promise;
        }
        return inputs.map(() => [0, 1]);
      });
      const sync = memoryManager.sync({ reason: "clear-reply-failure", force: true });
      void sync.catch(() => undefined);
      try {
        await Promise.race([
          Promise.all([cached.promise, allProvidersEntered.promise]),
          clearFailed.promise.then((error) => {
            throw error;
          }),
          sync,
        ]);
        expect(calls.toSorted()).toEqual(["conflict", "good", "late"]);
        expect(cacheRows()).toEqual([{ hash: expect.any(String), dims: 2 }]);
        const retainedCache = fullCacheRows();
        releaseConflict.resolve();
        const clearError = await Promise.race([clearFailed.promise, sync]);
        expect(clearError).toMatchObject({ message: expect.stringContaining(errorMessage) });
        if (failurePoint === "publication admission") {
          expect(admissionRefused).toBe(true);
          expect(clearError).toBe(admissionError);
        }
        // Committed reply loss deleted the cache; pre-callback refusal leaves the exact original rows.
        const expectedCache = failurePoint === "committed clear reply" ? [] : retainedCache;
        expect(fullCacheRows()).toEqual(expectedCache);
        releaseLate.resolve();
        const failure: unknown = await sync.catch((error: unknown) => error);
        expect(failure).toMatchObject({ message: expect.stringContaining(errorMessage) });
        if (!(failure instanceof Error)) {
          throw new Error("Expected the original embedding publication failure");
        }
        expect(failure.cause).toBe(clearError);
        expect(fullCacheRows()).toEqual(expectedCache);
        expect(embed).toHaveBeenCalledTimes(3);
        expect(calls.toSorted()).toEqual(["conflict", "good", "late"]);
      } finally {
        releaseConflict.resolve();
        releaseLate.resolve();
        await Promise.allSettled([sync]);
        await memoryManager.close();
        manager = null;
      }
    },
  );

  it("refuses generated cache writes after database admission is revoked", async () => {
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    const harness = memoryManager as unknown as ReindexHarness;
    const publishedDb = harness.db;
    const queued = createDeferred<void>();
    let reservation: Awaited<ReturnType<typeof reservePublishedWriter>> | undefined;
    observePublishedReservations(publishedDb, () => {
      if (reservation) {
        queued.resolve();
      }
    });
    await memoryManager.sync({ reason: "cli", force: true });
    if (!harness.provider) {
      throw new Error("fixture provider missing");
    }
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "New reusable alpha memory.");
    vi.spyOn(harness.provider, "embedBatch").mockImplementationOnce(async (inputs) => {
      reservation = await reservePublishedWriter(() => {
        closeOpenClawAgentDatabasesForTest();
      });
      return inputs.map(() => [0, 1, 0]);
    });
    const sync = memoryManager.sync({ reason: "cli", force: true });
    void sync.catch(() => undefined);
    try {
      await Promise.race([queued.promise, sync]);
      expect(queryRows(publishedDb, "SELECT hash FROM memory_embedding_cache")).toEqual([]);
      reservation?.release();
      // Revocation also fences the transcript lock holding the published writer.
      await expect(reservation?.done).rejects.toThrow(
        /^Agent database execution admission is closed$/,
      );
      await expect(sync).rejects.toThrow(/^Agent database execution admission is closed$/);
      // Readmission waits until the revoked write and its native owner settle.
      await closeOpenClawAgentDatabasesAsync();
      const reopenedDb = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" }).db;
      expect(reopenedDb.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([]);
    } finally {
      reservation?.release();
      await Promise.allSettled([reservation?.done, sync]);
    }
  });

  it("drains accepted sync through provider and writer waits before closing", async () => {
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    await memoryManager.sync({ reason: "baseline", force: true });
    const harness = memoryManager as unknown as ReindexHarness; // SAFETY: this fixture owns the manager and provider.
    const db = harness.db;
    const databasePath = db.location();
    if (!databasePath) {
      throw new Error("Expected the fixture's file-backed memory index");
    }
    if (!harness.provider) {
      throw new Error("fixture provider missing");
    }
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "Accepted sync survives close.");
    const entered = createDeferred<void>();
    const releaseProvider = createDeferred<void>();
    vi.spyOn(harness.provider, "embedBatch").mockImplementationOnce(async (inputs) => {
      entered.resolve();
      await releaseProvider.promise;
      return inputs.map(() => [0, 1, 0]);
    });
    const sync = memoryManager.sync({ reason: "closing", force: true });
    void sync.catch(() => undefined);
    let reservation: Awaited<ReturnType<typeof reservePublishedWriter>> | undefined;
    let close: Promise<void> | undefined;
    let closed = false;
    try {
      await Promise.race([entered.promise, sync]);
      reservation = await reservePublishedWriter();
      close = memoryManager.close().then(() => {
        closed = true;
      });
      void close.catch(() => undefined);
      await yieldToEventLoop();
      expect(closed).toBe(false);
      releaseProvider.resolve();
      await yieldToEventLoop();
      expect(closed).toBe(false);
      reservation.release();
      await Promise.all([sync, close, reservation.done]);
      expect(db.isOpen).toBe(false);
      using reader = new DatabaseSync(databasePath, { readOnly: true });
      expect(chunkTexts(reader)).toEqual([{ text: "Accepted sync survives close." }]);
    } finally {
      releaseProvider.resolve();
      reservation?.release();
      await Promise.allSettled([sync, close, reservation?.done]);
    }
  });

  it("retains successful batches when a later batch in the same file fails", async () => {
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as ReindexHarness;
    const provider = harness.provider;
    if (!provider) {
      throw new Error("expected the test embedding provider");
    }
    await fs.writeFile(
      path.join(memoryDir, "large.md"),
      `${"first ".repeat(3500)}\n${"second ".repeat(3500)}`,
    );
    let completed: unknown[] = [];
    const requests = vi.spyOn(provider, "embedBatch").mockImplementation(async (inputs) => {
      if (completed.length > 0) {
        throw new Error("permanent embedding failure");
      }
      completed = inputs;
      return inputs.map(() => [0, 1, 0]);
    });

    await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "permanent embedding failure",
    );
    expect(completed.length).toBeGreaterThan(0);
    expect(chunkTexts(harness.db)).toEqual([{ text: "published alpha" }]);
    requests.mockRestore();
    embeddingCalls = [];

    await memoryManager.sync({ reason: "cli", force: true });

    expect(embeddingCalls.flat().length).toBeGreaterThan(0);
    for (const input of completed) {
      expect(embeddingCalls.flat()).not.toContain(input);
    }
  });

  it.each(["batch-test", "batch-wide-test"] as const)(
    "retains completed %s runtime batches after a late rebuild failure",
    async (provider) => {
      const cfg = createCfg({
        provider,
        sources: ["memory"],
        cacheEnabled: true,
        batchEnabled: true,
      });
      const alphaPath = path.join(memoryDir, "alpha.md");
      const betaPath = path.join(memoryDir, "beta.md");
      await fs.writeFile(alphaPath, "published alpha");
      await fs.writeFile(betaPath, "published beta");
      const memoryManager = await openManager(cfg);
      await memoryManager.sync({ reason: "cli", force: true });
      await fs.writeFile(alphaPath, "replacement alpha");
      await fs.writeFile(betaPath, "replacement beta");
      batchEmbeddingCalls = [];
      const metadata = vi
        .spyOn(MemoryIndexDatabase.prototype, "writeMetadata")
        .mockImplementationOnce(() => {
          throw new Error("late runtime batch failure");
        });

      await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
        "late runtime batch failure",
      );
      expect(batchEmbeddingCalls.flat()).toEqual(
        expect.arrayContaining(["replacement alpha", "replacement beta"]),
      );
      metadata.mockRestore();
      await memoryManager.close();
      manager = null;
      const reopened = await openManager(cfg);
      batchEmbeddingCalls = [];

      await reopened.sync({ reason: "cli", force: true });

      expect(batchEmbeddingCalls).toEqual([]);
    },
  );

  it("bounds the canonical cache after a successful all-cache-hit rebuild", async () => {
    const { memoryManager, harness, newest } = await createOversizedPublishedCache();
    embeddingCalls = [];
    const observed = observePublishedSql(harness.db);
    const deletes = () =>
      observed
        .calls()
        .filter(({ sql }) => /^\s*DELETE\s+FROM\s+["`]?memory_embedding_cache\b/i.test(sql));
    const reads = () =>
      observed
        .calls()
        .filter(({ sql }) =>
          /^\s*SELECT\b[\s\S]*?\bFROM\s+["`]?memory_embedding_cache\b/i.test(sql),
        );
    try {
      expect(
        queryRow(harness.db, "SELECT COUNT(*) AS c FROM memory_embedding_cache WHERE 0"),
      ).toEqual({
        c: 0,
      });
      expect(() => harness.db.prepare("DELETE FROM memory_embedding_cache WHERE 0").run()).toThrow(
        /readonly/i,
      );
      expect([reads().length, deletes().length]).toEqual([1, 1]);
      observed.clear();

      await memoryManager.sync({ reason: "cli", force: true });

      expect(embeddingCalls).toEqual([]);
      expect({ reads: reads(), deletes: deletes() }).toEqual({ reads: [], deletes: [] });
      expect(publishedCacheRows(harness.db)).toEqual(newest);
      expect(chunkTexts(harness.db)).toEqual([{ text: "published alpha" }]);
    } finally {
      observed.restore();
    }
  });

  it("preserves the cache when a full rebuild fails without writing embeddings", async () => {
    const { memoryManager, harness, before } = await createOversizedPublishedCache();
    vi.spyOn(MemoryIndexDatabase.prototype, "writeMetadata").mockImplementation(() => {
      throw new Error("failed shadow metadata");
    });

    await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "failed shadow metadata",
    );

    expect(publishedCacheRows(harness.db)).toEqual(before);
  });

  async function createOversizedPublishedCache() {
    const memoryManager = await openManager(
      createCfg({ sources: ["memory", "sessions"], cacheEnabled: true }),
    );
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as ReindexHarness;
    const insert = openOpenClawAgentDatabase({ agentId: "main" }).db.prepare(`
      INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES ('previous-provider', 'previous-model', 'previous-key', ?, ?, 3, 1)
    `);
    insert.run("old-a", encodeMemoryEmbedding([0, 1, 0]));
    insert.run("old-b", encodeMemoryEmbedding([0, 1, 0]));
    harness.cache.maxEntries = 1;
    const before = publishedCacheRows(harness.db);
    expect(before).toHaveLength(3);
    const newest = queryRows(
      harness.db,
      "SELECT * FROM memory_embedding_cache ORDER BY updated_at DESC LIMIT 1",
    );
    return { memoryManager, harness, before, newest };
  }

  it.each([
    { force: false, outcome: "bounds the published cache" },
    { force: true, outcome: "preserves the published cache" },
  ])("$outcome on unavailable-provider preflight (force=$force)", async ({ force }) => {
    const { memoryManager, harness, before, newest } = await createOversizedPublishedCache();
    // Model runtime provider loss after successful initialization; keep the
    // real sync admission, provider preflight, and SQLite cache cleanup intact.
    harness.provider = null;

    await expect(memoryManager.sync({ reason: "cli", force })).rejects.toThrow(
      /Memory sync unavailable: embedding provider "openai" is configured but unavailable\./,
    );

    expect(publishedCacheRows(harness.db)).toEqual(force ? before : newest);
  });

  it("bounds unresolved targeted sync cache even when forced", async () => {
    const { memoryManager, harness, newest } = await createOversizedPublishedCache();
    const publishedChunks = queryRows(harness.db, "SELECT * FROM memory_index_chunks ORDER BY id");

    await memoryManager.sync({
      reason: "queued-sessions",
      force: true,
      sessions: [
        { agentId: "main", sessionId: "missing-session", sessionKey: "agent:main:missing-session" },
      ],
    });

    expect(publishedCacheRows(harness.db)).toEqual(newest);
    expect(queryRows(harness.db, "SELECT * FROM memory_index_chunks ORDER BY id")).toEqual(
      publishedChunks,
    );
  });

  it("waits for an active reindex beyond the reset lock budget", async () => {
    const memoryManager = await openManager(createCfg({ provider: "none", sources: ["memory"] }));
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const lock = await waitForMemoryReindexLock(databasePath);

    let settled = false;
    const sync = memoryManager.sync({ reason: "test", force: true }).finally(() => {
      settled = true;
    });
    const outcome = sync.catch((error: unknown) => error);
    try {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 2_100);
      });
      expect(settled).toBe(false);
    } finally {
      await lock.release();
    }
    await expect(outcome).resolves.toBeUndefined();
  });

  it("refuses reset during incremental embeddings, then clears and rebuilds their writes", async () => {
    const memoryPath = path.join(memoryDir, "alpha.md");
    await fs.writeFile(memoryPath, "published alpha");
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as ReindexHarness;
    const provider = harness.provider;
    if (!provider) {
      throw new Error("expected the test embedding provider");
    }
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const reset = () =>
      resetMemoryDatabase({
        targetDb: requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db),
        dbPath: databasePath,
        workspaceDir,
      });
    const embeddingGate = createDeferred<void>();
    const embeddingStarted = createDeferred<void>();
    vi.spyOn(provider, "embedBatch").mockImplementationOnce(async (inputs) => {
      embeddingStarted.resolve();
      await embeddingGate.promise;
      return inputs.map(() => [0, 1, 0]);
    });
    await fs.writeFile(memoryPath, "incremental beta");
    harness.dirty = true;
    const activeSync = memoryManager.sync({ reason: "session-delta" });
    try {
      await embeddingStarted.promise;
      await expect(reset()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      expect(chunkTexts(harness.db)).toEqual([{ text: "published alpha" }]);
    } finally {
      embeddingGate.resolve();
      await activeSync;
    }

    expect(chunkTexts(harness.db)).toEqual([{ text: "incremental beta" }]);
    await expect(reset()).resolves.toBe(true);
    for (const table of ["memory_index_sources", "memory_index_chunks", "memory_embedding_cache"]) {
      expect(queryRow(harness.db, `SELECT COUNT(*) AS count FROM ${table}`)).toEqual({
        count: 0,
      });
    }
    await memoryManager.sync({ reason: "cli" });
    expect(chunkTexts(harness.db)).toEqual([{ text: "incremental beta" }]);
    expect(queryRow(harness.db, "SELECT COUNT(*) AS count FROM memory_embedding_cache")).toEqual({
      count: 1,
    });
  });

  it("forces source-wide session sync when retrying a failed full reindex", async () => {
    const memoryManager = await openManager(createCfg({ provider: "none", sources: ["sessions"] }));
    await memoryManager.sync({ reason: "test", force: true });

    const harness = memoryManager as unknown as ReindexHarness;
    const sessionSyncCalls: SyncArchiveParams[] = [];

    harness.sessionsDirty = true;
    harness.sessionsFullRetryDirty = true;
    harness.sessionsDirtyFiles.clear();
    harness.syncArchiveFiles = async (params) => {
      sessionSyncCalls.push(params);
      return { indexItems: [], finalize: () => undefined };
    };

    await harness.sync({ reason: "test" });

    expect(sessionSyncCalls).toHaveLength(1);
    expect(sessionSyncCalls[0]).toMatchObject({ needsFullReindex: true });
    expect(sessionSyncCalls[0]?.targetArchiveFiles).toBeUndefined();
    expect(harness).toMatchObject({ sessionsDirty: false, sessionsFullRetryDirty: false });
  });

  it("full-reindexes sessions-only retry state when metadata is mismatched", async () => {
    const memoryManager = await openManager(createCfg({ provider: "none", sources: ["sessions"] }));
    await memoryManager.sync({ reason: "test", force: true });

    const harness = memoryManager as unknown as ReindexHarness;
    const databasePath = harness.db.location();
    if (!databasePath) {
      throw new Error("Expected the fixture's file-backed memory index");
    }
    {
      // Observe the worker-published schema before injecting an orphan through a fixture writer.
      using writer = new DatabaseSync(databasePath);
      writer
        .prepare(
          `INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES ('sessions-retry-chunk', 'sessions/retry.jsonl', 'sessions', 1, 1,
           'sessions-retry-hash', 'fts-only', 'sessions retry marker', ?, ?)`,
        )
        .run(encodeMemoryEmbedding([]), Date.now());
    }
    await harness.database.writeMetadata({
      model: "fts-only",
      provider: "none",
      providerKey: harness.providerKey ?? undefined,
      sources: ["memory"],
      chunkTokens: 4000,
      chunkOverlap: 0,
    });
    harness.sessionsDirty = true;
    harness.sessionsFullRetryDirty = true;

    await harness.sync({ reason: "test" });

    expect(chunkTexts(harness.db)).toEqual([]);
    expect(memoryManager.status().custom?.indexIdentity).toMatchObject({ status: "valid" });
    expect(harness).toMatchObject({ sessionsDirty: false, sessionsFullRetryDirty: false });
  });
  /** The manager's own handle is read-only; tests write through the agent database. */
  function cacheWriter() {
    return openOpenClawAgentDatabase({ agentId: "main" }).db;
  }

  function insertCacheRow(
    { provider, model, provider_key }: CacheIdentity,
    hash: string,
    updatedAt: number,
  ): void {
    cacheWriter()
      .prepare(
        `INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES (?, ?, ?, ?, ?, 3, ?)`,
      )
      .run(provider, model, provider_key, hash, encodeMemoryEmbedding([0, 1, 0]), updatedAt);
  }

  function cacheHashes(db: DatabaseSync): string[] {
    const hashes = queryRows(db, "SELECT hash FROM memory_embedding_cache ORDER BY hash");
    return (hashes as Array<{ hash: string }>).map((row) => row.hash);
  }

  /** Index two files, then age their cache rows so plain oldest-first eviction would pick them. */
  async function indexLiveRows() {
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await fs.writeFile(path.join(memoryDir, "beta.md"), "published beta");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as ReindexHarness;
    cacheWriter().prepare("UPDATE memory_embedding_cache SET updated_at = 1").run();
    const identity = queryRow(
      harness.db,
      "SELECT provider, model, provider_key FROM memory_embedding_cache",
    ) as CacheIdentity;
    return { memoryManager, harness, identity, live: cacheHashes(harness.db) };
  }

  it("evicts unreferenced rows before older live rows when a full rebuild exceeds the cap", async () => {
    const { memoryManager, harness, identity, live } = await indexLiveRows();
    expect(live).toHaveLength(2);
    for (let i = 0; i < 3; i += 1) {
      insertCacheRow(identity, `orphan-${i}`, 2 + i);
    }
    const foreign = { provider: "other", model: "other-model", provider_key: "other-key" };
    insertCacheRow(foreign, "orphan-foreign", 2);
    // Six rows against a cap of four: the prune removes exactly two.
    harness.cache.maxEntries = 4;
    embeddingCalls = [];

    await memoryManager.sync({ reason: "cli", force: true });

    expect(embeddingCalls).toEqual([]);
    expect(cacheHashes(harness.db)).toEqual([...live, "orphan-2", "orphan-foreign"].toSorted());
  });

  it("evicts unreferenced rows first when an incremental sync writes at the cap", async () => {
    const { memoryManager, harness, identity, live } = await indexLiveRows();
    insertCacheRow(identity, "orphan-0", 2);
    harness.cache.maxEntries = 3;
    await fs.writeFile(path.join(memoryDir, "gamma.md"), "published gamma");
    // The file watcher is off in tests; mark the change it would report.
    harness.dirty = true;
    embeddingCalls = [];

    await memoryManager.sync({ reason: "cli" });

    expect(embeddingCalls).toHaveLength(1);
    const remaining = cacheHashes(harness.db);
    expect(remaining).toHaveLength(3);
    expect(remaining).not.toContain("orphan-0");
    expect(remaining).toEqual(expect.arrayContaining(live));
  });

  it("keeps plain oldest-first order for a vector another sync cached during the rebuild", async () => {
    const { memoryManager, harness, identity, live } = await indexLiveRows();
    // The rebuild start and the sibling's write share one controlled clock.
    const now = 2_000_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    // A sibling caches a vector for a chunk it has not published yet, after this
    // rebuild started and before it publishes. No published chunk carries its hash.
    const metadata = vi.spyOn(MemoryIndexDatabase.prototype, "writeMetadata");
    metadata.mockImplementationOnce(function (this: MemoryIndexDatabase, meta) {
      insertCacheRow(identity, "pending-sibling", Date.now());
      metadata.mockRestore();
      return this.writeMetadata(meta);
    });
    harness.cache.maxEntries = 2;

    await memoryManager.sync({ reason: "cli", force: true });

    // Three rows against two: the oldest row goes, as without a preference.
    const remaining = cacheHashes(harness.db);
    expect(remaining).toHaveLength(2);
    expect(remaining).toContain("pending-sibling");
    expect(remaining.filter((hash) => live.includes(hash))).toHaveLength(1);
  });

  it("keeps a failed rebuild's vector when its retry writes at the cap", async () => {
    const { memoryManager, harness, live } = await indexLiveRows();
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "alpha edited");
    await fs.writeFile(path.join(memoryDir, "beta.md"), "beta edited POISON");
    onEmbedBatch = (inputs) => {
      if (
        inputs.some((input) => (typeof input === "string" ? input : input.text).includes("POISON"))
      ) {
        throw new Error("400 invalid request");
      }
    };
    harness.cache.maxEntries = 3;
    await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "invalid request",
    );
    const retryVectors = cacheHashes(harness.db).filter((hash) => !live.includes(hash));
    expect(retryVectors).toHaveLength(1);
    onEmbedBatch = undefined;
    await fs.writeFile(path.join(memoryDir, "beta.md"), "beta edited");
    embeddingCalls = [];

    await memoryManager.sync({ reason: "cli", force: true });

    // Only the fixed file is embedded; the retry vector is reused and survives
    // the eviction its write needs, which takes an older row instead.
    expect(embeddingCalls).toEqual([["beta edited"]]);
    expect(cacheHashes(harness.db)).toEqual(expect.arrayContaining(retryVectors));
  });
});
