import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { captureEnv } from "openclaw/plugin-sdk/test-env";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

let providerConstructionError: Error | null = null;
let providerConstructionGate: Promise<void> | null = null;
let providerAvailable = false;
let providerEmbeddingError: Error | null = null;
let providerQueryError: Error | null = null;
let providerQueryCalls = 0;
let providerBatchCalls = 0;
const createProvider = vi.hoisted(() =>
  vi.fn(async () => {
    await providerConstructionGate;
    if (providerConstructionError) {
      throw providerConstructionError;
    }
    if (providerAvailable) {
      return {
        requestedProvider: "auto",
        provider: {
          id: "openai",
          model: "mock-embed",
          embedBatch: async (texts: string[]) => {
            providerBatchCalls += 1;
            if (providerEmbeddingError) {
              throw providerEmbeddingError;
            }
            return texts.map(() => [1, 0]);
          },
          embed: async () => {
            providerQueryCalls += 1;
            if (providerQueryError) {
              throw providerQueryError;
            }
            return [1, 0];
          },
        },
      };
    }
    return {
      requestedProvider: "auto",
      provider: null,
      providerUnavailableReason: "No embeddings provider available.",
    };
  }),
);
function missingProviderAuth() {
  return Object.assign(
    new Error(
      'No API key resolved for provider "openai" (auth mode: api-key, checked: OPENAI_API_KEY).',
    ),
    { name: "MissingProviderAuthError", code: "missing-api-key", provider: "openai" },
  );
}

const stateEnv = captureEnv(["OPENCLAW_STATE_DIR"]);
const bootstrapError = "embedding request failed during bootstrap";
const memoryHit = expect.objectContaining({ path: "MEMORY.md", source: "memory" });

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createProvider,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  resolveEmbeddingProviderFallbackModel: () => "fts-only",
}));

describe("memory manager FTS-only reindex", () => {
  let fixtureRoot = "";
  let caseId = 0;
  let workspaceDir = "";
  let indexPath = "";
  let managers: MemoryIndexManager[] = [];

  beforeAll(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-fts-only-"));
  });

  beforeEach(async () => {
    createProvider.mockClear();
    providerConstructionError = null;
    providerConstructionGate = null;
    providerAvailable = false;
    providerEmbeddingError = null;
    providerQueryError = null;
    providerQueryCalls = 0;
    providerBatchCalls = 0;
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await writeMemory("Alpha topic\n\nKeep this note.");
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", path.join(workspaceDir, "state"));
    indexPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const manager of managers.toReversed()) {
      await manager.close();
    }
    managers = [];
    await closeAllMemorySearchManagers();
    clearRuntimeConfigSnapshot();
    stateEnv.restore();
  });

  afterAll(async () => {
    await closeAllMemorySearchManagers();
    // The agent close releases its leases through shared state and reopens it, so the
    // shared handle is released second; otherwise Windows fails the removal with EBUSY.
    closeOpenClawAgentDatabasesForTest();
    await closeOpenClawStateDatabaseAsync();
    resetPluginStateStoreForTests();
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  async function createManager(
    params: {
      provider?: string;
      purpose?: "status" | "cli";
      vectorEnabled?: boolean;
      rememberAcrossConversations?: boolean;
    } = {},
  ): Promise<MemoryIndexManager> {
    const store =
      params.vectorEnabled === undefined
        ? undefined
        : { vector: { enabled: params.vectorEnabled } };
    const cfg = {
      // Provider construction is mocked here; avoid cold-loading real plugins during config resolution.
      plugins: { enabled: false },
      memory: {
        backend: "builtin",

        search: {
          provider: params.provider,
          rememberAcrossConversations: params.rememberAcrossConversations,
          model: "",
          store,
          cache: { enabled: false },
        },
      },
      agents: { defaults: { workspace: workspaceDir }, entries: { main: {} } },
    } as OpenClawConfig;
    setRuntimeConfigSnapshot(cfg);
    const result = await getMemorySearchManager({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg,
      agentId: "main",
      purpose: params.purpose,
    });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    const manager = result.manager as unknown as MemoryIndexManager;
    managers.push(manager);
    return manager;
  }

  const writeMemory = (text: string) => fs.writeFile(path.join(workspaceDir, "MEMORY.md"), text);

  function freezeTime() {
    const now = Date.now();
    return { now, clock: vi.spyOn(Date, "now").mockReturnValue(now) };
  }

  async function indexedManager(provider?: string) {
    providerAvailable = true;
    const manager = await createManager({ provider });
    await manager.sync({ force: true });
    return manager;
  }

  async function closeManager(manager: MemoryIndexManager) {
    await manager.close();
    await closeAllMemorySearchManagers();
  }

  function expectSearch(manager: MemoryIndexManager, query = "Alpha topic") {
    return expect(manager.search(query)).resolves.toHaveLength(1);
  }

  async function searchDebug(manager: MemoryIndexManager) {
    const debug: unknown[] = [];
    await expect(
      manager.search("Alpha topic", { onDebug: (entry) => debug.push(entry) }),
    ).resolves.toEqual([memoryHit]);
    return debug;
  }

  function awaitIdle(manager: MemoryIndexManager) {
    return (manager as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();
  }

  async function failedBootstrap() {
    const { now, clock } = freezeTime();
    providerConstructionError = missingProviderAuth();
    const manager = await createManager();
    await expectSearch(manager);
    return { manager, now, clock };
  }

  const quotaError = () =>
    Object.assign(new Error("embedding quota exhausted"), {
      status: 429,
      errorCode: "insufficient_quota",
    });

  function expectBootstrap(debug: unknown[], bootstrap: Record<string, unknown>) {
    expect(debug).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ embeddingBootstrap: expect.objectContaining(bootstrap) }),
      ]),
    );
  }

  function countChunksContaining(term: string): number {
    using db = new DatabaseSync(indexPath);
    const row = db
      .prepare(`SELECT COUNT(*) as c FROM memory_index_chunks WHERE text LIKE ?`)
      .get(`%${term}%`) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  it("keeps a reopened semantic index valid before discovering the provider model", async () => {
    const indexed = await indexedManager("openai");
    expect(indexed.status().chunks).toBeGreaterThan(0);
    await closeManager(indexed);
    createProvider.mockClear();

    const reopened = await createManager({ provider: "openai", purpose: "status" });
    expect(reopened.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expect(reopened.status().custom?.providerState).toEqual({
      mode: "pending",
      requestedProvider: "openai",
    });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it.each(["first search", "failed background sync"])(
    "returns keyword matches after an embedding failure during %s",
    async (phase) => {
      providerAvailable = true;
      providerEmbeddingError = new Error(bootstrapError);
      const manager = await createManager();
      if (phase === "failed background sync") {
        await expect(manager.sync({ reason: "watch" })).rejects.toThrow(bootstrapError);
      }
      const debug = await searchDebug(manager);
      expect(providerQueryCalls).toBe(0);
      expectBootstrap(debug, {
        degradedTo: "keyword-only",
        provider: "openai",
        reason: expect.stringContaining(bootstrapError),
      });
    },
  );

  it("backs off when the first keyword-only publication also fails", async () => {
    const { now, clock } = freezeTime();
    providerAvailable = true;
    providerEmbeddingError = new Error(bootstrapError);
    const manager = await createManager();
    const metadata = vi
      .spyOn(MemoryIndexDatabase.prototype, "writeMetadata")
      .mockImplementationOnce(() => {
        throw new Error("keyword publication failed");
      });

    await expect(manager.search("Alpha topic")).resolves.toEqual([]);
    await expect(manager.search("Alpha topic")).resolves.toEqual([]);
    expect(metadata).toHaveBeenCalledOnce();

    providerAvailable = false;
    clock.mockReturnValue(now + 60_000);
    await expect(manager.search("Alpha topic")).resolves.toEqual([memoryHit]);
  });

  it.each(["watch", "search maintenance", "keyword-only"])(
    "preserves the original quota cooldown and %s index",
    async (origin) => {
      const keywordOnly = origin === "keyword-only";
      const coldClock = keywordOnly ? freezeTime() : undefined;
      providerAvailable = true;
      if (keywordOnly) {
        providerEmbeddingError = providerQueryError = quotaError();
      }
      const manager = keywordOnly ? await createManager() : await indexedManager();
      const { now, clock } = coldClock ?? freezeTime();
      providerEmbeddingError = providerQueryError = quotaError();
      if (!keywordOnly) {
        await writeMemory("Alpha topic\n\nPending quota update.");
        // The observation fixture leaves dirty notification to the test.
        Reflect.set(manager, "dirty", true);
      }
      if (origin === "watch") {
        await expect(manager.sync({ reason: "watch" })).rejects.toThrow(
          "embedding quota exhausted",
        );
      } else {
        await expectSearch(manager);
        await awaitIdle(manager);
      }
      const requestsAfterFailure = providerBatchCalls + providerQueryCalls;

      for (const [elapsed, marker] of [
        [10_000, "Gamma keyword update"],
        [29_999, "Delta keyword update"],
      ] as const) {
        clock.mockReturnValue(now + elapsed);
        if (keywordOnly) {
          await writeMemory(`${marker}\n\nKeep this note.`);
          Reflect.set(manager, "dirty", true);
          await manager.search(marker);
        } else {
          await expectSearch(manager);
        }
        await awaitIdle(manager);
        expect(providerBatchCalls + providerQueryCalls).toBe(requestsAfterFailure);
        expect(manager.getCachedEmbeddingAvailability()?.cacheExpiresAtMs).toBe(now + 30_000);
        if (keywordOnly) {
          expect(countChunksContaining(marker)).toBeGreaterThan(0);
          await expectSearch(manager, marker);
        } else {
          expect(countChunksContaining("Pending quota update")).toBe(0);
        }
      }
      if (keywordOnly) {
        return;
      }
      providerEmbeddingError = null;
      providerQueryError = null;
      clock.mockReturnValue(now + 30_000);
      await expectSearch(manager);
      await awaitIdle(manager);
      expect(providerBatchCalls + providerQueryCalls).toBeGreaterThan(requestsAfterFailure);
      expect(countChunksContaining("Pending quota update")).toBeGreaterThan(0);
      expect(manager.status().custom?.providerState).toEqual({
        mode: "active",
        providerId: "openai",
      });
    },
  );

  it.each(["construction", "runtime query"])(
    "fails closed on required provider %s",
    async (phase) => {
      const construction = phase === "construction";
      const error = construction ? missingProviderAuth() : new Error("query embedding failed");
      providerConstructionError = construction ? error : null;
      const manager = construction
        ? await createManager({ provider: "openai" })
        : await indexedManager("openai");
      if (construction) {
        await expect(
          manager.sync({ reason: "session-startup-catchup", force: true }),
        ).rejects.toThrow(error);
        expect(countChunksContaining("Alpha topic")).toBe(0);
      } else {
        expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
        providerQueryError = error;
      }
      await expect(manager.search("Alpha topic")).rejects.toThrow(error);
    },
  );

  it("uses keyword search when provider construction fails against an existing semantic index", async () => {
    const credential = "sk-test-abcdefghijklmnopqrstuvwxyz123456";
    const { now, clock } = freezeTime();
    const firstManager = await indexedManager();
    await expect(firstManager.probeVectorAvailability()).resolves.toBe(true);
    await closeManager(firstManager);
    providerAvailable = false;
    providerConstructionError = missingProviderAuth();
    providerConstructionError.message += ` apiKey=${credential}`;
    const manager = await createManager();
    const debug = await searchDebug(manager);
    expectBootstrap(debug, { degradedTo: "keyword-only" });
    expect(JSON.stringify(debug)).not.toContain(credential);
    expect(manager.status()).toMatchObject({
      provider: "none",
      model: undefined,
      vector: { semanticAvailable: false },
      custom: { indexIdentity: { status: "valid" }, searchMode: "fts-only" },
    });

    providerConstructionError = null;
    providerAvailable = true;
    clock.mockReturnValue(now + 31_000);
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    await expectSearch(manager);

    expect(providerQueryCalls).toBeGreaterThan(0);
    expect(manager.status()).toMatchObject({
      provider: "openai",
      vector: { semanticAvailable: true },
      custom: { providerState: { mode: "active", providerId: "openai" } },
    });
  });

  it("caches a normal no-provider result after an expired bootstrap failure", async () => {
    const { manager, now, clock } = await failedBootstrap();

    providerConstructionError = null;
    clock.mockReturnValue(now + 31_000);
    const debug = await searchDebug(manager);
    const callsAfterRetry = createProvider.mock.calls.length;
    await expectSearch(manager);

    expect(createProvider).toHaveBeenCalledTimes(callsAfterRetry);
    expect(JSON.stringify(debug)).toContain("No embeddings provider available.");
  });

  it("degrades concurrent bootstrap waiters to the same keyword index", async () => {
    const construction = createDeferred<void>();
    providerConstructionGate = construction.promise;
    providerConstructionError = missingProviderAuth();
    const manager = await createManager();

    const backgroundSync = manager.sync({ reason: "startup" }).catch((err: unknown) => err);
    await vi.waitFor(() => expect(createProvider).toHaveBeenCalledOnce());
    const firstSearch = manager.search("Alpha topic");
    const secondSearch = manager.search("Alpha topic");
    construction.resolve();

    await expect(backgroundSync).resolves.toBeUndefined();
    const results = await Promise.all([firstSearch, secondSearch]);
    expect(results).toEqual([[memoryHit], [memoryHit]]);
    expect(createProvider).toHaveBeenCalledOnce();
  });

  it("serializes provider construction when concurrent probes retry an expired failure", async () => {
    const { manager, now, clock } = await failedBootstrap();
    const callsBeforeRetry = createProvider.mock.calls.length;

    providerConstructionError = null;
    providerAvailable = true;
    clock.mockReturnValue(now + 31_000);
    const construction = createDeferred<void>();
    providerConstructionGate = construction.promise;
    const firstProbe = manager.probeEmbeddingAvailability();
    const secondProbe = manager.probeEmbeddingAvailability();
    await vi.waitFor(() => expect(createProvider).toHaveBeenCalledTimes(callsBeforeRetry + 1));
    construction.resolve();

    await expect(Promise.all([firstProbe, secondProbe])).resolves.toEqual([
      { ok: true },
      { ok: true },
    ]);
    expect(createProvider).toHaveBeenCalledTimes(callsBeforeRetry + 1);
    await expectSearch(manager);
    expect(manager.status()).toMatchObject({
      provider: "openai",
      custom: {
        indexIdentity: { status: "valid" },
        providerState: { mode: "active", providerId: "openai" },
      },
    });
  });

  it("keeps keyword results when semantic recovery reindex fails", async () => {
    const { manager, now, clock } = await failedBootstrap();

    providerConstructionError = null;
    providerAvailable = true;
    clock.mockReturnValue(now + 31_000);
    await expect(manager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
    providerEmbeddingError = new Error("embedding request failed during rebuild");
    const queryCallsAfterProbe = providerQueryCalls;
    const debug = await searchDebug(manager);
    expect(providerQueryCalls).toBe(queryCallsAfterProbe);
    expectBootstrap(debug, {
      degradedTo: "keyword-only",
      reason: expect.stringContaining("embedding request failed during rebuild"),
    });
    expect(JSON.stringify(debug)).not.toContain("No API key resolved");
    expect(manager.status().custom?.indexIdentity).toEqual({ status: "valid" });

    for (const [elapsed, marker] of [
      [31_000, "Gamma fallback refresh"],
      [62_000, "Delta fallback refresh"],
    ] as const) {
      clock.mockReturnValue(now + elapsed);
      await writeMemory(marker);
      await expect(manager.sync({ reason: "watch", force: true })).resolves.toBeUndefined();
      await expectSearch(manager, marker);
      expect(providerQueryCalls).toBe(queryCallsAfterProbe);
    }

    providerEmbeddingError = null;
    clock.mockReturnValue(now + 93_000);
    await expect(manager.sync({ reason: "watch", force: true })).resolves.toBeUndefined();
    await expectSearch(manager, "Delta fallback refresh");
    expect(providerQueryCalls).toBeGreaterThan(queryCallsAfterProbe);
    const recoveredStatus = manager.status();
    expect(recoveredStatus.custom?.providerState).toEqual({ mode: "active", providerId: "openai" });
    expect(recoveredStatus.custom?.providerUnavailableReason).toBeUndefined();
  });

  it.skipIf(process.platform === "win32")(
    "syncs regular memory when USER.md is a symlink",
    async () => {
      const linkedUserPath = path.join(workspaceDir, "shared-user.md");
      await fs.writeFile(linkedUserPath, "Linked user content must not be indexed.");
      await fs.symlink(linkedUserPath, path.join(workspaceDir, "USER.md"));
      const manager = await createManager({ provider: "none", vectorEnabled: false });

      await expect(manager.sync({ reason: "cli", force: true })).resolves.toBeUndefined();

      expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
      expect(countChunksContaining("Linked user content")).toBe(0);
    },
  );

  it("ignores persisted vector rebuild debt after reopening an FTS-only index", async () => {
    const manager = await createManager({ provider: "none" });
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.prepare(
      `INSERT INTO memory_index_meta (key, value) VALUES ('memory_vector_rebuild_v1', '1')`,
    ).run();

    await manager.sync({ force: true });
    await closeManager(manager);

    const reopened = await createManager({ provider: "none", purpose: "status" });
    await expect(reopened.probeEmbeddingAvailability()).resolves.toEqual({
      ok: false,
      error: "No embedding provider available (FTS-only mode)",
    });
    expect(createProvider).not.toHaveBeenCalled();
    expect(reopened.status()).toMatchObject({
      dirty: false,
      vector: { enabled: false, index: { state: "empty" } },
      custom: { indexIdentity: { status: "valid" } },
    });
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("aborts instead of downgrading an existing semantic index to FTS-only", async () => {
    await closeManager(await indexedManager());
    providerAvailable = false;
    const manager = await createManager();

    await expect(manager.sync({ force: true })).rejects.toThrow(
      "Refusing to run sync in fts-only fallback mode to protect existing vector index (current model: mock-embed).",
    );
    expect(manager.status().provider).toBe("openai");
  });

  function seedChunksWithNoMeta(model = "fts-only"): void {
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.exec(`
      INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES ('chunk-1', 'MEMORY.md', 'memory', 1, 3, 'hash-1', '${model}', 'Alpha topic keep note', x'', ${Date.now()});
      INSERT INTO memory_index_sources (path, source, hash, mtime, size)
        VALUES ('MEMORY.md', 'memory', 'hash-1', ${Date.now()}, 100);
    `);
  }

  it.each([
    ["fts-only", "valid", false],
    ["text-embedding-3-small", "missing", true],
  ] as const)(
    "reconciles missing %s identity without a provider",
    async (model, identity, dirty) => {
      seedChunksWithNoMeta(model);
      const manager = await createManager({ provider: "auto", vectorEnabled: false });
      expect(manager.status().custom?.indexIdentity).toMatchObject({ status: "missing" });
      await manager.sync();
      const statusAfter = manager.status();
      expect(statusAfter).toMatchObject({ dirty, custom: { indexIdentity: { status: identity } } });
      if (dirty) {
        expect(statusAfter.chunks).toBe(1);
        using db = new DatabaseSync(indexPath);
        expect(db.prepare("SELECT model FROM memory_index_chunks").get()).toEqual({ model });
      } else {
        expect(statusAfter.chunks).toBeGreaterThan(0);
      }
    },
  );

  it("removes chunks and FTS rows when the dirty source file is already deleted", async () => {
    const seedDb = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
    expect(() => seedDb.loadExtension("not-a-real-extension")).toThrow(
      "extension loading is not allowed",
    );
    const loaded = await loadSqliteVecExtension({ db: seedDb });
    expect(() => seedDb.loadExtension("not-a-real-extension")).toThrow(
      "extension loading is not allowed",
    );
    expect(() => seedDb.prepare("SELECT load_extension(?)").get("not-a-real-extension")).toThrow(
      "not authorized",
    );
    expect(loaded.ok, loaded.error).toBe(true);
    ensureMemoryIndexSchema({ db: seedDb, cacheEnabled: false, ftsEnabled: true });
    seedDb.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES ('memory/deleted.md', 'memory', '', 200, 20),
            ('memory/ownerless.md', 'memory', '', 190, 20),
            ('sessions/excluded.jsonl', 'sessions', '', 200, 20);
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
          VALUES ('chunk-canonical', 'memory/deleted.md', 'memory', 1, 2, 'canonical-chunk-hash',
            'fts-only', 'obsolete saffronquasar', x'', 200),
            ('chunk-ownerless', 'memory/ownerless.md', 'memory', 1, 2, 'ownerless-chunk-hash',
            'fts-only', 'obsolete ambercomet', x'', 190);
        CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[3]);
        INSERT INTO memory_index_chunks_vec VALUES ('chunk-canonical', '[1,0,0]'), ('chunk-ownerless', '[0,1,0]');
        INSERT INTO memory_index_meta (key, value)
          VALUES ('memory_vector_rebuild_v1', 'clean');
      `);
    const manager = await createManager({
      provider: "none",
      vectorEnabled: false,
      rememberAcrossConversations: false,
    });
    const db = seedDb;
    const countRows = (table: string, sourcePath: string) =>
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE path = ?`).get(sourcePath);
    await (
      manager as unknown as {
        syncMemoryFiles(params: { needsFullReindex: boolean }): Promise<unknown>;
      }
    ).syncMemoryFiles({ needsFullReindex: false });

    for (const sourcePath of ["memory/deleted.md", "memory/ownerless.md"]) {
      for (const table of [
        "memory_index_sources",
        "memory_index_chunks",
        "memory_index_chunks_fts",
      ]) {
        expect(countRows(table, sourcePath), `${table}: ${sourcePath}`).toEqual({ count: 0 });
      }
    }
    expect(countRows("memory_index_sources", "sessions/excluded.jsonl")).toEqual({ count: 1 });
    // Cleanup ran while vectors were disabled. Keep the old table untouched and
    // persist a rebuild marker; one-sided orphan pruning would still miss vector
    // rows that should exist but were never written.
    expect(
      db
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
        .get(),
    ).toEqual({ value: "1" });
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get()).toEqual({
      count: 2,
    });
  });
});
