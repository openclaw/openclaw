import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resolveSessionTranscriptsDirForAgent,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { registerEmbeddingProvider } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "./test-runtime-mocks.js";
import { seedMemoryForgetTombstones } from "../test-helpers.js";
import type { EmbeddingProvider } from "./embeddings.js";
import { memoryCpuProcessEntrypoints } from "./manager-cpu-entrypoints.js";
import { resetMemoryDatabase } from "./manager-db.js";
import { memoryPublicationFaultEntrypoint } from "./manager-publication-fault-entrypoint.test-support.js";
import {
  observePublishedReservations,
  observePublishedSql,
  reservePublishedWriter,
} from "./manager-publication-observer.test-support.js";
import { waitForMemoryReindexLock } from "./manager-reindex-lock.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";
import { isolateMemoryManagerTestConfig } from "./test-config-helpers.js";

type SyncArchiveParams = { needsFullReindex: boolean; targetArchiveFiles?: string[] };

type ReindexHarness = {
  sync: (params: { reason?: string; force?: boolean }) => Promise<void>;
  runInPlaceReindex: (params: { reason?: string; force?: boolean }) => Promise<void>;
  syncArchiveFiles: (params: SyncArchiveParams) => Promise<unknown>;
  db: DatabaseSync;
  cache: { enabled: boolean; maxEntries?: number };
  writeMeta: (meta: MemoryIndexMeta) => void;
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
  let batchEmbeddingCalls: string[][] = [];

  beforeEach(async () => {
    embeddingCalls = [];
    batchEmbeddingCalls = [];
    // Register the fixture at the same boundary used by config and provider creation.
    registerEmbeddingProvider({
      id: "openai",
      transport: "remote",
      create: async () => ({
        provider: {
          id: "openai",
          model: "mock-embed",
          maxInputTokens: 8192,
          embed: async () => [0, 1, 0],
          embedBatch: async (inputs) => {
            embeddingCalls.push(inputs);
            return inputs.map(() => [0, 1, 0]);
          },
        },
      }),
    });
    for (const id of ["batch-test", "batch-wide-test"] as const) {
      registerEmbeddingProvider({
        id,
        transport: "remote",
        create: async () => ({
          provider: {
            id,
            model: "mock-embed",
            maxInputTokens: 8192,
            embed: async () => [0, 1, 0],
            embedBatch: async (inputs) => inputs.map(() => [0, 1, 0]),
          },
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
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
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
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        list: [{ id: "main", default: true }],
      },
    });
  }

  async function openManager(cfg: OpenClawConfig): Promise<MemoryIndexManager> {
    const { getMemorySearchManager } = await import("./index.js");
    const result = await getMemorySearchManager({ cfg, agentId: "main" });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    if (!("sync" in result.manager) || typeof result.manager.sync !== "function") {
      throw new Error("manager does not support sync");
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
    vi.spyOn(harness, "writeMeta").mockImplementationOnce(() => {
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

  it.each([
    { name: "inconsistent dimensions", invalid: [0, 1] },
    { name: "nonfinite coordinates", invalid: [0, Number.NaN, 0] },
  ])("does not retain $name after rejected provider output", async ({ invalid }) => {
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
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
    const embed = vi
      .spyOn(harness.provider, "embedBatch")
      .mockImplementationOnce(async (inputs) => {
        expect(inputs.length).toBeGreaterThan(1);
        return inputs.map((_, index) => (index === 0 ? [0, 1, 0] : invalid));
      });
    await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow();
    expect(harness.db.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([]);
    await memoryManager.sync({ reason: "cli", force: true });
    expect(embed).toHaveBeenCalledTimes(2);
    expect(
      harness.db.prepare("SELECT hash FROM memory_embedding_cache").all().length,
    ).toBeGreaterThan(0);
  });

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
    harness.db
      .prepare(`INSERT INTO memory_embedding_cache
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
        harness.db
          .prepare("SELECT hash FROM memory_embedding_cache WHERE provider = 'openai'")
          .all().length,
      ).toBeGreaterThan(0);
      reservation?.release();
      await reservation?.done;
      await expect(sync).rejects.toThrow("malformed vector response");
    } finally {
      reservation?.release();
      await reservation?.done;
      await sync.catch(() => undefined);
    }
    expect(embed.mock.calls.length).toBeGreaterThan(1);
    expect(harness.db.prepare("SELECT provider FROM memory_embedding_cache").all()).toEqual([
      { provider: "unrelated" },
    ]);
    await memoryManager.close();
    manager = null;
    const reopened = await openManager(cfg);
    await expect(reopened.sync({ reason: "cli", force: true })).resolves.toBeUndefined();
    expect(
      (reopened as unknown as ReindexHarness).db
        .prepare("SELECT DISTINCT dims FROM memory_embedding_cache WHERE provider = 'openai'")
        .all(),
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
        publishedDb.prepare("SELECT hash, dims FROM memory_embedding_cache ORDER BY hash").all();
      const fullCacheRows = () =>
        publishedDb.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all();
      const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStore;
      vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStore").mockImplementation(
        async (...args) => {
          const [options, source, workerInput] = args;
          if (
            source !== publishedDb ||
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
          const run = worker.run.bind(worker);
          vi.spyOn(worker, "run").mockImplementation(async (...runArgs) => {
            try {
              if (
                failurePoint === "publication admission" &&
                conflictReturned &&
                !admissionRefused
              ) {
                admissionRefused = true;
                throw admissionError;
              }
              const result = await run(...runArgs);
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

  it.each(["purge", "replace"] as const)(
    "revalidates generated cache writes after published writer admission (%s)",
    async (scenario) => {
      const cfg = createCfg({ sources: ["memory"], cacheEnabled: true });
      const memoryManager = await openManager(cfg);
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
      let replacementDb: DatabaseSync | undefined;
      vi.spyOn(harness.provider, "embedBatch").mockImplementationOnce(async (inputs) => {
        reservation = await reservePublishedWriter(() => {
          if (scenario === "purge") {
            seedMemoryForgetTombstones({
              agentId: "main",
              sessionIds: ["forgotten-during-embedding"],
            });
          } else if (scenario === "replace") {
            closeOpenClawAgentDatabasesForTest();
            replacementDb = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" }).db;
          }
        });
        return inputs.map(() => [0, 1, 0]);
      });
      const sync = memoryManager.sync({ reason: "cli", force: true });
      void sync.catch(() => undefined);
      try {
        await Promise.race([queued.promise, sync]);
        expect(publishedDb.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([]);
        reservation?.release();
        await reservation?.done;
        await expect(sync).rejects.toThrow(
          scenario === "replace"
            ? /^Agent database execution admission is closed$/
            : /Memory index changed/,
        );
        expect(
          (replacementDb ?? publishedDb).prepare("SELECT hash FROM memory_embedding_cache").all(),
        ).toEqual([]);
      } finally {
        reservation?.release();
        await reservation?.done;
        await sync.catch(() => undefined);
      }
    },
  );

  it("drains accepted sync through provider and writer waits before closing", async () => {
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    await memoryManager.sync({ reason: "baseline", force: true });
    const harness = memoryManager as unknown as ReindexHarness; // SAFETY: this fixture owns the manager and provider.
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
      expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
        { text: "Accepted sync survives close." },
      ]);
    } finally {
      releaseProvider.resolve();
      reservation?.release();
      await Promise.allSettled([sync, close, reservation?.done]);
    }
  });

  it("retains completed embeddings across a failed rebuild and manager restart", async () => {
    const cfg = createCfg({ sources: ["memory"], cacheEnabled: true });
    const memoryPath = path.join(memoryDir, "alpha.md");
    await fs.writeFile(memoryPath, "published alpha");
    const memoryManager = await openManager(cfg);
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as ReindexHarness;
    const observed = observePublishedSql(harness.db);
    const cacheWrites = () =>
      observed
        .calls()
        .filter(
          ({ method, sql }) =>
            method === "run" &&
            /(?:INSERT INTO|DELETE FROM|UPDATE) ["`]?memory_embedding_cache\b/i.test(sql),
        )
        .map(({ sql }) => sql);
    harness.db.prepare("UPDATE memory_embedding_cache SET updated_at = updated_at WHERE 0").run();
    expect(cacheWrites()).toHaveLength(1);
    observed.clear();
    const published = harness.db.prepare("SELECT text FROM memory_index_chunks").all();
    await fs.writeFile(memoryPath, "replacement beta");
    const metadata = vi.spyOn(harness, "writeMeta").mockImplementationOnce(() => {
      throw new Error("late shadow failure");
    });

    await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "late shadow failure",
    );
    expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual(published);
    expect(cacheWrites()).toEqual([]);
    observed.restore();
    metadata.mockRestore();
    const paidInputs = embeddingCalls.flat();
    expect(paidInputs).toContain("replacement beta");
    await memoryManager.close();
    manager = null;
    const reopened = await openManager(cfg);
    embeddingCalls = [];

    await reopened.sync({ reason: "cli", force: true });

    expect(embeddingCalls.flat()).toEqual([]);
    expect(
      (reopened as unknown as ReindexHarness).db
        .prepare("SELECT text FROM memory_index_chunks")
        .all(),
    ).toEqual([{ text: "replacement beta" }]);
  });

  it("retains successful batches when a later batch in the same file fails", async () => {
    const cfg = createCfg({ sources: ["memory"], cacheEnabled: true });
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    const memoryManager = await openManager(cfg);
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
    expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "published alpha" },
    ]);
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
      const harness = memoryManager as unknown as ReindexHarness;
      await fs.writeFile(alphaPath, "replacement alpha");
      await fs.writeFile(betaPath, "replacement beta");
      batchEmbeddingCalls = [];
      const metadata = vi.spyOn(harness, "writeMeta").mockImplementationOnce(() => {
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

  it("bounds the shadow cache before any entries reach the primary", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStore;
    const interceptedSources: Array<Parameters<typeof open>[1]> = [];
    // Install before manager startup can retain its canonical publication client.
    vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStore").mockImplementation(
      async (...args) => {
        const [options, source, worker] = args;
        if (
          options.agentId !== "main" ||
          options.path !== databasePath ||
          worker.moduleUrl.href !==
            resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.publication).href
        ) {
          return await open(...args);
        }
        const client = await open(options, source, {
          ...worker,
          moduleUrl: resolveRuntimeWorkerUrl(memoryPublicationFaultEntrypoint),
          input: { kind: "cache-capacity", publication: worker.input, maximum: 2 },
        });
        interceptedSources.push(source);
        return client;
      },
    );
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    const harness = memoryManager as unknown as ReindexHarness;
    harness.cache.maxEntries = 2;
    for (let i = 0; i < 4; i += 1) {
      await fs.writeFile(path.join(memoryDir, `${i}.md`), `unique cache content ${i}`);
    }
    // Reject transient overflow too: checking only the final row count misses
    // primary-file high-water growth followed by post-publication deletion.
    await memoryManager.sync({ reason: "cli", force: true });

    expect(interceptedSources.length).toBeGreaterThan(0);
    for (const source of interceptedSources) {
      expect(source === harness.db).toBe(true);
    }
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get(),
    ).toEqual({ count: 2 });
    expect(harness.db.prepare("SELECT COUNT(*) AS count FROM memory_index_sources").get()).toEqual({
      count: 4,
    });
  });

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
        harness.db.prepare("SELECT COUNT(*) AS c FROM memory_embedding_cache WHERE 0").get(),
      ).toEqual({ c: 0 });
      expect(harness.db.prepare("DELETE FROM memory_embedding_cache WHERE 0").run().changes).toBe(
        0,
      );
      expect([reads().length, deletes().length]).toEqual([1, 1]);
      observed.clear();

      await memoryManager.sync({ reason: "cli", force: true });

      expect(embeddingCalls).toEqual([]);
      expect({ reads: reads(), deletes: deletes() }).toEqual({ reads: [], deletes: [] });
      expect(
        harness.db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all(),
      ).toEqual(newest);
      expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
        { text: "published alpha" },
      ]);
    } finally {
      observed.restore();
    }
  });

  it("leaves even an oversized published cache untouched when a full rebuild fails", async () => {
    const { memoryManager, harness, before } = await createOversizedPublishedCache();
    harness.writeMeta = () => {
      throw new Error("failed shadow metadata");
    };

    await expect(memoryManager.sync({ reason: "cli", force: true })).rejects.toThrow(
      "failed shadow metadata",
    );

    expect(harness.db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all()).toEqual(
      before,
    );
  });

  async function createOversizedPublishedCache() {
    const memoryManager = await openManager(
      createCfg({ sources: ["memory", "sessions"], cacheEnabled: true }),
    );
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as ReindexHarness;
    const insert = harness.db.prepare(`
      INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES ('previous-provider', 'previous-model', 'previous-key', ?, ?, 3, 1)
    `);
    insert.run("old-a", encodeMemoryEmbedding([0, 1, 0]));
    insert.run("old-b", encodeMemoryEmbedding([0, 1, 0]));
    harness.cache.maxEntries = 1;
    const before = harness.db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all();
    expect(before).toHaveLength(3);
    const newest = harness.db
      .prepare("SELECT * FROM memory_embedding_cache ORDER BY updated_at DESC LIMIT 1")
      .all();
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

    expect(harness.db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all()).toEqual(
      force ? before : newest,
    );
  });

  it("bounds unresolved targeted sync cache even when forced", async () => {
    const { memoryManager, harness, newest } = await createOversizedPublishedCache();
    const publishedChunks = harness.db
      .prepare("SELECT * FROM memory_index_chunks ORDER BY id")
      .all();

    await memoryManager.sync({
      reason: "queued-sessions",
      force: true,
      sessions: [
        { agentId: "main", sessionId: "missing-session", sessionKey: "agent:main:missing-session" },
      ],
    });

    expect(harness.db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all()).toEqual(
      newest,
    );
    expect(harness.db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all()).toEqual(
      publishedChunks,
    );
  });

  it("still bounds committed incremental work when its progress callback fails", async () => {
    const memoryManager = await openManager(createCfg({ sources: ["memory"], cacheEnabled: true }));
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "published alpha");
    await memoryManager.sync({ reason: "cli", force: true });
    const harness = memoryManager as unknown as ReindexHarness;
    harness.cache.maxEntries = 1;
    harness.dirty = true;
    await fs.writeFile(path.join(memoryDir, "alpha.md"), "incremental beta");

    await expect(
      memoryManager.sync({
        reason: "session-delta",
        progress: ({ completed }) => {
          if (completed > 0) {
            throw new Error("failed progress callback");
          }
        },
      }),
    ).rejects.toThrow("failed progress callback");

    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get(),
    ).toEqual({ count: 1 });
    expect(harness.db.prepare("SELECT text FROM memory_index_chunks").get()).toEqual({
      text: "incremental beta",
    });
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
      resetMemoryDatabase({ targetDb: harness.db, dbPath: databasePath, workspaceDir });
    let releaseEmbedding = () => {};
    let markEmbeddingStarted = () => {};
    const embeddingGate = new Promise<void>((resolve) => {
      releaseEmbedding = resolve;
    });
    const embeddingStarted = new Promise<void>((resolve) => {
      markEmbeddingStarted = resolve;
    });
    vi.spyOn(provider, "embedBatch").mockImplementationOnce(async (inputs) => {
      markEmbeddingStarted();
      await embeddingGate;
      return inputs.map(() => [0, 1, 0]);
    });
    await fs.writeFile(memoryPath, "incremental beta");
    harness.dirty = true;
    const activeSync = memoryManager.sync({ reason: "session-delta" });
    try {
      await embeddingStarted;
      await expect(reset()).rejects.toMatchObject({ code: "SQLITE_BUSY" });
      expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
        { text: "published alpha" },
      ]);
    } finally {
      releaseEmbedding();
      await activeSync;
    }

    expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "incremental beta" },
    ]);
    await expect(reset()).resolves.toBe(true);
    for (const table of ["memory_index_sources", "memory_index_chunks", "memory_embedding_cache"]) {
      expect(harness.db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
        count: 0,
      });
    }
    await memoryManager.sync({ reason: "cli" });
    expect(harness.db.prepare("SELECT text FROM memory_index_chunks").all()).toEqual([
      { text: "incremental beta" },
    ]);
    expect(
      harness.db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get(),
    ).toEqual({
      count: 1,
    });
  });

  it("forces source-wide session sync when retrying a failed full reindex", async () => {
    const memoryManager = await openManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
      }),
    );
    await memoryManager.sync({ reason: "test", force: true });

    const harness = memoryManager as unknown as ReindexHarness;
    const emptySyncPlan = { indexItems: [], finalize: () => undefined };
    const sessionSyncCalls: SyncArchiveParams[] = [];

    harness.sessionsDirty = true;
    harness.sessionsFullRetryDirty = true;
    harness.sessionsDirtyFiles.clear();
    harness.syncArchiveFiles = async (params) => {
      sessionSyncCalls.push(params);
      return emptySyncPlan;
    };

    await harness.sync({ reason: "test" });

    expect(sessionSyncCalls).toHaveLength(1);
    expect(sessionSyncCalls[0]).toMatchObject({ needsFullReindex: true });
    expect(sessionSyncCalls[0]?.targetArchiveFiles).toBeUndefined();
    expect(harness.sessionsDirty).toBe(false);
    expect(harness.sessionsFullRetryDirty).toBe(false);
  });

  it("full-reindexes sessions-only retry state when metadata is mismatched", async () => {
    const memoryManager = await openManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
      }),
    );
    await memoryManager.sync({ reason: "test", force: true });

    const harness = memoryManager as unknown as ReindexHarness;
    const reindexCalls: Array<{ reason?: string; force?: boolean }> = [];

    harness.db
      .prepare(
        `INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "sessions-retry-chunk",
        "sessions/retry.jsonl",
        "sessions",
        1,
        1,
        "sessions-retry-hash",
        "fts-only",
        "sessions retry marker",
        encodeMemoryEmbedding([]),
        Date.now(),
      );
    harness.writeMeta({
      model: "fts-only",
      provider: "none",
      providerKey: harness.providerKey ?? undefined,
      sources: ["memory"],
      chunkTokens: 4000,
      chunkOverlap: 0,
    });
    harness.sessionsDirty = true;
    harness.sessionsFullRetryDirty = true;
    harness.runInPlaceReindex = async (params) => {
      reindexCalls.push(params);
    };

    await harness.sync({ reason: "test" });

    expect(reindexCalls).toHaveLength(1);
    expect(reindexCalls[0]).toMatchObject({ reason: "test" });
  });
});
