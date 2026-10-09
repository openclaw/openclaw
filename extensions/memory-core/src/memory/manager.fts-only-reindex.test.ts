import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resetPluginStateStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  closeOpenClawStateDatabaseAsync,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { closeAllMemorySearchManagers, getMemorySearchManager } from "./index.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemoryIndexManager } from "./manager.js";
import "./test-runtime-mocks.js";

let providerConstructionError: Error | null = null;
let providerConstructionGate: Promise<void> | null = null;
let providerAvailable = false;
let providerEmbeddingError: Error | null = null;
let providerQueryError: Error | null = null;
let providerQueryCalls = 0;
const createEmbeddingProviderMock = vi.hoisted(() =>
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

const originalFtsOnlyStateDir = process.env.OPENCLAW_STATE_DIR;

function setFtsOnlyStateDir(stateDir: string): void {
  Reflect.set(process.env, "OPENCLAW_STATE_DIR", stateDir);
}

function restoreFtsOnlyStateDir(): void {
  if (originalFtsOnlyStateDir === undefined) {
    Reflect.deleteProperty(process.env, "OPENCLAW_STATE_DIR");
  } else {
    Reflect.set(process.env, "OPENCLAW_STATE_DIR", originalFtsOnlyStateDir);
  }
}

vi.mock("./embeddings.js", () => ({
  createEmbeddingProvider: createEmbeddingProviderMock,
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
    createEmbeddingProviderMock.mockClear();
    providerConstructionError = null;
    providerConstructionGate = null;
    providerAvailable = false;
    providerEmbeddingError = null;
    providerQueryError = null;
    providerQueryCalls = 0;
    workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory"), { recursive: true });
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Alpha topic\n\nKeep this note.");
    setFtsOnlyStateDir(path.join(workspaceDir, "state"));
    indexPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
  });

  afterEach(async () => {
    for (const manager of managers.toReversed()) {
      await manager.close();
    }
    managers = [];
    await closeAllMemorySearchManagers();
    restoreFtsOnlyStateDir();
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
      agents: {
        defaults: {
          workspace: workspaceDir,
        },
        entries: { main: {} },
      },
    } as OpenClawConfig;
    const result = await getMemorySearchManager({ cfg, agentId: "main", purpose: params.purpose });
    if (!result.manager) {
      throw new Error(result.error ?? "manager missing");
    }
    const manager = result.manager as unknown as MemoryIndexManager;
    managers.push(manager);
    return manager;
  }

  function countChunksContaining(term: string): number {
    const db = new DatabaseSync(indexPath);
    try {
      const row = db
        .prepare(`SELECT COUNT(*) as c FROM memory_index_chunks WHERE text LIKE ?`)
        .get(`%${term}%`) as { c: number } | undefined;
      return row?.c ?? 0;
    } finally {
      db.close();
    }
  }

  function writeExistingMeta(memoryManager: MemoryIndexManager, model: string): void {
    const metaWriter = memoryManager as unknown as {
      writeMeta(meta: MemoryIndexMeta): void;
    };
    metaWriter.writeMeta({
      model,
      provider: "openai",
      chunkTokens: 600,
      chunkOverlap: 120,
      sources: ["memory"],
    });
  }

  it("keeps a reopened semantic index valid before discovering the provider model", async () => {
    providerAvailable = true;
    const indexed = await createManager({ provider: "openai" });
    await indexed.sync({ force: true });
    expect(indexed.status().chunks).toBeGreaterThan(0);
    await indexed.close();
    await closeAllMemorySearchManagers();
    createEmbeddingProviderMock.mockClear();

    const reopened = await createManager({ provider: "openai", purpose: "status" });
    expect(reopened.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expect(reopened.status().custom?.providerState).toEqual({
      mode: "pending",
      requestedProvider: "openai",
    });
    expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
  });

  it("returns keyword matches when the first bootstrap embedding request fails", async () => {
    providerAvailable = true;
    providerEmbeddingError = new Error("embedding request failed during bootstrap");
    const memoryManager = await createManager();
    const debug: unknown[] = [];

    const results = await memoryManager.search("Alpha topic", {
      onDebug: (entry) => debug.push(entry),
    });

    expect(results).toEqual([expect.objectContaining({ path: "MEMORY.md", source: "memory" })]);
    expect(providerQueryCalls).toBe(0);
    expect(debug).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          embeddingBootstrap: expect.objectContaining({
            degradedTo: "keyword-only",
            provider: "openai",
            reason: expect.stringContaining("embedding request failed during bootstrap"),
          }),
        }),
      ]),
    );
  });

  it("falls back to keyword results when the default query embedding fails", async () => {
    providerAvailable = true;
    const memoryManager = await createManager();
    await memoryManager.sync({ force: true });
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
    await expect(memoryManager.search("Alpha topic")).resolves.toHaveLength(1);
    expect(providerQueryCalls).toBeGreaterThan(0);

    providerQueryError = new Error("query embedding request failed at runtime");
    const results = await memoryManager.search("Alpha topic");

    expect(results).toEqual([expect.objectContaining({ path: "MEMORY.md", source: "memory" })]);
  });

  it("keeps explicit providers fail-closed when a runtime query embedding fails", async () => {
    providerAvailable = true;
    const memoryManager = await createManager({ provider: "openai" });
    await memoryManager.sync({ force: true });
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);

    providerQueryError = new Error("query embedding request failed at runtime");

    await expect(memoryManager.search("Alpha topic")).rejects.toThrow(
      "query embedding request failed at runtime",
    );
  });

  it("keeps explicit required providers fail-closed when construction fails", async () => {
    providerConstructionError = missingProviderAuth();
    const memoryManager = await createManager({ provider: "openai" });

    await expect(
      memoryManager.sync({ reason: "session-startup-catchup", force: true }),
    ).rejects.toThrow('No API key resolved for provider "openai"');
    await expect(memoryManager.search("Alpha topic")).rejects.toThrow(
      'No API key resolved for provider "openai"',
    );
    expect(countChunksContaining("Alpha topic")).toBe(0);
  });

  it("uses keyword search when provider construction fails against an existing semantic index", async () => {
    const credential = "sk-test-abcdefghijklmnopqrstuvwxyz123456";
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      providerAvailable = true;
      const firstManager = await createManager();
      await firstManager.sync({ force: true });
      await expect(firstManager.probeVectorAvailability()).resolves.toBe(true);
      await firstManager.close();
      await closeAllMemorySearchManagers();
      providerAvailable = false;
      providerConstructionError = missingProviderAuth();
      providerConstructionError.message += ` apiKey=${credential}`;
      const memoryManager = await createManager();
      const debug: unknown[] = [];

      await expect(
        memoryManager.search("Alpha topic", { onDebug: (entry) => debug.push(entry) }),
      ).resolves.toEqual([expect.objectContaining({ path: "MEMORY.md", source: "memory" })]);
      expect(debug).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            embeddingBootstrap: expect.objectContaining({ degradedTo: "keyword-only" }),
          }),
        ]),
      );
      expect(JSON.stringify(debug)).not.toContain(credential);
      expect(
        memoryManager as unknown as {
          embeddingBootstrapFailure?: unknown;
          provider?: { id: string } | null;
        },
      ).toMatchObject({
        embeddingBootstrapFailure: expect.objectContaining({ degradedTo: "keyword-only" }),
        provider: null,
      });
      expect(memoryManager.status()).toMatchObject({
        provider: "none",
        model: undefined,
        vector: { semanticAvailable: false },
        custom: { indexIdentity: { status: "valid" }, searchMode: "fts-only" },
      });

      providerConstructionError = null;
      providerAvailable = true;
      nowSpy.mockReturnValue(now + 31_000);
      await expect(memoryManager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
      await expect(memoryManager.search("Alpha topic")).resolves.toHaveLength(1);

      expect(providerQueryCalls).toBeGreaterThan(0);
      expect(memoryManager.status()).toMatchObject({
        provider: "openai",
        vector: { semanticAvailable: true },
        custom: { providerState: { mode: "active", providerId: "openai" } },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("caches a normal no-provider result after an expired bootstrap failure", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      providerConstructionError = missingProviderAuth();
      const memoryManager = await createManager();
      await expect(memoryManager.search("Alpha topic")).resolves.toHaveLength(1);

      providerConstructionError = null;
      nowSpy.mockReturnValue(now + 31_000);
      const debug: unknown[] = [];
      await expect(
        memoryManager.search("Alpha topic", { onDebug: (entry) => debug.push(entry) }),
      ).resolves.toHaveLength(1);
      const callsAfterRetry = createEmbeddingProviderMock.mock.calls.length;
      await expect(memoryManager.search("Alpha topic")).resolves.toHaveLength(1);

      expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(callsAfterRetry);
      expect(JSON.stringify(debug)).toContain("No embeddings provider available.");
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("degrades concurrent bootstrap waiters to the same keyword index", async () => {
    let releaseProviderConstruction!: () => void;
    providerConstructionGate = new Promise<void>((resolve) => {
      releaseProviderConstruction = resolve;
    });
    providerConstructionError = missingProviderAuth();
    const memoryManager = await createManager();

    const backgroundSync = memoryManager.sync({ reason: "startup" }).catch((err: unknown) => err);
    await vi.waitFor(() => expect(createEmbeddingProviderMock).toHaveBeenCalledOnce());
    const firstSearch = memoryManager.search("Alpha topic");
    const secondSearch = memoryManager.search("Alpha topic");
    releaseProviderConstruction();

    await expect(backgroundSync).resolves.toBeUndefined();
    const results = await Promise.all([firstSearch, secondSearch]);
    expect(results).toEqual([
      [expect.objectContaining({ path: "MEMORY.md", source: "memory" })],
      [expect.objectContaining({ path: "MEMORY.md", source: "memory" })],
    ]);
    expect(createEmbeddingProviderMock).toHaveBeenCalledOnce();
  });

  it("serializes provider construction when concurrent probes retry an expired failure", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      providerConstructionError = missingProviderAuth();
      const memoryManager = await createManager();
      await expect(memoryManager.search("Alpha topic")).resolves.toHaveLength(1);
      const callsBeforeRetry = createEmbeddingProviderMock.mock.calls.length;

      providerConstructionError = null;
      providerAvailable = true;
      nowSpy.mockReturnValue(now + 31_000);
      let releaseProviderConstruction!: () => void;
      providerConstructionGate = new Promise<void>((resolve) => {
        releaseProviderConstruction = resolve;
      });
      const firstProbe = memoryManager.probeEmbeddingAvailability();
      const secondProbe = memoryManager.probeEmbeddingAvailability();
      await vi.waitFor(() =>
        expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(callsBeforeRetry + 1),
      );
      releaseProviderConstruction();

      await expect(Promise.all([firstProbe, secondProbe])).resolves.toEqual([
        { ok: true },
        { ok: true },
      ]);
      expect(createEmbeddingProviderMock).toHaveBeenCalledTimes(callsBeforeRetry + 1);
      await expect(memoryManager.search("Alpha topic")).resolves.toHaveLength(1);
      expect(memoryManager.status()).toMatchObject({
        provider: "openai",
        custom: {
          indexIdentity: { status: "valid" },
          providerState: { mode: "active", providerId: "openai" },
        },
      });
    } finally {
      nowSpy.mockRestore();
    }
  });

  it("keeps keyword results when semantic recovery reindex fails", async () => {
    const now = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      providerConstructionError = missingProviderAuth();
      const memoryManager = await createManager();
      await expect(memoryManager.search("Alpha topic")).resolves.toHaveLength(1);

      providerConstructionError = null;
      providerAvailable = true;
      nowSpy.mockReturnValue(now + 31_000);
      await expect(memoryManager.probeEmbeddingAvailability()).resolves.toEqual({ ok: true });
      providerEmbeddingError = new Error("embedding request failed during rebuild");
      const debug: unknown[] = [];

      await expect(
        memoryManager.search("Alpha topic", { onDebug: (entry) => debug.push(entry) }),
      ).resolves.toHaveLength(1);
      expect(providerQueryCalls).toBe(0);
      expect(debug).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            embeddingBootstrap: expect.objectContaining({
              degradedTo: "keyword-only",
              reason: expect.stringContaining("embedding request failed during rebuild"),
            }),
          }),
        ]),
      );
      expect(JSON.stringify(debug)).not.toContain("No API key resolved");
      expect(memoryManager.status().custom?.indexIdentity).toEqual({ status: "valid" });

      await fs.writeFile(
        path.join(workspaceDir, "MEMORY.md"),
        "Gamma fallback refresh\n\nIndexed while embeddings remain degraded.",
      );
      await expect(memoryManager.sync({ reason: "watch", force: true })).resolves.toBeUndefined();
      await expect(memoryManager.search("Gamma fallback refresh")).resolves.toHaveLength(1);
      expect(providerQueryCalls).toBe(0);

      nowSpy.mockReturnValue(now + 62_000);
      await fs.writeFile(
        path.join(workspaceDir, "MEMORY.md"),
        "Delta fallback refresh\n\nRetry remains keyword-only while embeddings still fail.",
      );
      await expect(memoryManager.sync({ reason: "watch", force: true })).resolves.toBeUndefined();
      await expect(memoryManager.search("Delta fallback refresh")).resolves.toHaveLength(1);
      expect(providerQueryCalls).toBe(0);

      providerEmbeddingError = null;
      nowSpy.mockReturnValue(now + 93_000);
      await expect(memoryManager.sync({ reason: "watch", force: true })).resolves.toBeUndefined();
      await expect(memoryManager.search("Delta fallback refresh")).resolves.toHaveLength(1);
      expect(providerQueryCalls).toBeGreaterThan(0);
      const recoveredStatus = memoryManager.status();
      expect(recoveredStatus.custom?.providerState).toEqual({
        mode: "active",
        providerId: "openai",
      });
      expect(recoveredStatus.custom?.providerUnavailableReason).toBeUndefined();
    } finally {
      nowSpy.mockRestore();
    }
  });

  it.skipIf(process.platform === "win32")(
    "syncs regular memory when USER.md is a symlink",
    async () => {
      const linkedUserPath = path.join(workspaceDir, "shared-user.md");
      await fs.writeFile(linkedUserPath, "Linked user content must not be indexed.");
      await fs.symlink(linkedUserPath, path.join(workspaceDir, "USER.md"));
      const memoryManager = await createManager({ provider: "none", vectorEnabled: false });

      await expect(memoryManager.sync({ reason: "cli", force: true })).resolves.toBeUndefined();

      expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
      expect(countChunksContaining("Linked user content")).toBe(0);
    },
  );

  it("forces provider-none memory to FTS-only when vector config is omitted", async () => {
    const memoryManager = await createManager({ provider: "none" });

    await memoryManager.sync({ force: true });

    await expect(memoryManager.probeEmbeddingAvailability()).resolves.toEqual({
      ok: false,
      error: "No embedding provider available (FTS-only mode)",
    });
    const status = memoryManager.status();
    expect(createEmbeddingProviderMock).not.toHaveBeenCalled();
    expect(status.vector).toMatchObject({ enabled: false });
    expect(status.custom?.indexIdentity).toEqual({ status: "valid" });
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("ignores persisted vector rebuild debt after reopening an FTS-only index", async () => {
    const memoryManager = await createManager({ provider: "none" });
    const db = Reflect.get(memoryManager, "db") as DatabaseSync;
    db.prepare(
      `INSERT INTO memory_index_meta (key, value) VALUES ('memory_vector_rebuild_v1', '1')`,
    ).run();

    await memoryManager.sync({ force: true });
    await memoryManager.close();
    await closeAllMemorySearchManagers();

    const reopened = await createManager({ provider: "none", purpose: "status" });
    expect(reopened.status()).toMatchObject({
      dirty: false,
      vector: { enabled: false, index: { state: "empty" } },
      custom: { indexIdentity: { status: "valid" } },
    });
    expect(countChunksContaining("Alpha topic")).toBeGreaterThan(0);
  });

  it("aborts instead of downgrading an existing semantic index to FTS-only", async () => {
    const memoryManager = await createManager();
    writeExistingMeta(memoryManager, "mock-embed");

    await expect(memoryManager.sync({ force: true })).rejects.toThrow(
      "Refusing to run sync in fts-only fallback mode to protect existing vector index (current model: mock-embed).",
    );
    expect(memoryManager.status().provider).toBe("openai");
  });

  function indexIdentityStatus(memoryManager: MemoryIndexManager): string | undefined {
    const identity = memoryManager.status().custom?.indexIdentity as
      | { status?: string }
      | undefined;
    return identity?.status;
  }

  function seedChunksWithNoMeta(model = "fts-only"): void {
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.exec(`
      INSERT INTO memory_index_chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES ('chunk-1', 'MEMORY.md', 'memory', 1, 3, 'hash-1', '${model}', 'Alpha topic keep note', x'', ${Date.now()});
      INSERT INTO memory_index_sources (path, source, hash, mtime, size)
        VALUES ('MEMORY.md', 'memory', 'hash-1', ${Date.now()}, 100);
    `);
  }

  it("self-heals missing identity on non-forced gateway sync when all chunks are FTS-only and provider is unavailable", async () => {
    seedChunksWithNoMeta();
    const memoryManager = await createManager({ provider: "auto", vectorEnabled: false });

    expect(indexIdentityStatus(memoryManager)).toBe("missing");

    // Non-forced sync simulates the gateway's periodic sync loop
    await memoryManager.sync();

    const statusAfter = memoryManager.status();
    expect(indexIdentityStatus(memoryManager)).toBe("valid");
    expect(statusAfter.chunks).toBeGreaterThan(0);
    expect(statusAfter.dirty).toBe(false);
  });

  it("does not rebuild missing-identity semantic chunks when the provider is unavailable", async () => {
    seedChunksWithNoMeta("text-embedding-3-small");
    const memoryManager = await createManager({ provider: "auto", vectorEnabled: false });

    await memoryManager.sync();

    const statusAfter = memoryManager.status();
    expect(indexIdentityStatus(memoryManager)).toBe("missing");
    expect(statusAfter.chunks).toBe(1);
    expect(statusAfter.dirty).toBe(true);
  });

  it("observes a separate CLI reindex without reopening the live gateway manager", async () => {
    const liveManager = await createManager({ provider: "none" });
    await liveManager.sync({ reason: "test", force: true });
    (
      liveManager as unknown as {
        db: { exec: (sql: string) => void };
      }
    ).db.exec(`DELETE FROM memory_index_meta WHERE key = 'memory_index_meta_v1'`);
    expect(indexIdentityStatus(liveManager)).toBe("missing");

    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "Beta topic\n\nKeep this repaired note.",
    );
    const cliManager = await createManager({
      provider: "none",
      purpose: "cli",
    });
    await cliManager.sync({ reason: "cli", force: true });

    expect(indexIdentityStatus(liveManager)).toBe("valid");
    const results = await liveManager.search("beta repaired");
    expect(results.some((result) => result.snippet.includes("Beta topic"))).toBe(true);
  });

  it("removes chunks and FTS rows when the dirty source file is already deleted", async () => {
    const seedDb = openOpenClawAgentDatabase({ agentId: "main" }).db;
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
    const vectorExtensionPath = loaded.extensionPath;
    ensureMemoryIndexSchema({ db: seedDb, cacheEnabled: false, ftsEnabled: true });
    seedDb.exec(`
        INSERT INTO memory_index_sources (path, source, hash, mtime, size)
          VALUES
            ('memory/deleted.md', 'memory', '', 200, 20),
            ('memory/ownerless.md', 'memory', '', 190, 20),
            ('sessions/excluded.jsonl', 'sessions', '', 200, 20);
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES (
          'chunk-canonical', 'memory/deleted.md', 'memory', 1, 2, 'canonical-chunk-hash',
          'fts-only', 'obsolete saffronquasar', x'', 200
        );
        INSERT INTO memory_index_chunks
          (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES (
          'chunk-ownerless', 'memory/ownerless.md', 'memory', 1, 2, 'ownerless-chunk-hash',
          'fts-only', 'obsolete ambercomet', x'', 190
        );
        CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
          id TEXT PRIMARY KEY,
          embedding FLOAT[3]
        );
        INSERT INTO memory_index_chunks_vec VALUES ('chunk-canonical', '[1,0,0]');
        INSERT INTO memory_index_chunks_vec VALUES ('chunk-ownerless', '[0,1,0]');
        INSERT INTO memory_index_meta (key, value)
          VALUES ('memory_vector_rebuild_v1', 'clean');

      `);
    expect(seedDb.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get()).toEqual({
      count: 2,
    });

    const manager = await createManager({
      provider: "none",
      vectorEnabled: false,
      rememberAcrossConversations: false,
    });
    expect(manager.status().fts?.available).toBe(true);
    expect(Reflect.get(manager, "sessionsFullRetryDirty")).toBe(false);

    const db = Reflect.get(manager, "db") as DatabaseSync;
    expect(db).toBe(seedDb);
    const countRows = (table: string, sourcePath: string) =>
      db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE path = ?`).get(sourcePath);
    expect(
      db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'memory/deleted.md'").get(),
    ).toEqual({ hash: "" });
    expect(
      db.prepare("SELECT hash FROM memory_index_sources WHERE path = 'memory/ownerless.md'").get(),
    ).toEqual({ hash: "" });
    expect(countRows("memory_index_chunks", "memory/deleted.md")).toEqual({ count: 1 });
    expect(countRows("memory_index_chunks_fts", "memory/deleted.md")).toEqual({ count: 1 });
    expect(countRows("memory_index_chunks_fts", "memory/ownerless.md")).toEqual({ count: 1 });

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
    // Exercise the later vector-enabled load directly. Recreating the public
    // manager here also tests unrelated provider/cache retirement lifecycles.
    const vectorState = Reflect.get(manager, "vector") as {
      available: boolean | null;
      enabled: boolean;
      extensionPath?: string;
    };
    vectorState.enabled = true;
    vectorState.available = true;
    vectorState.extensionPath = vectorExtensionPath;
    Reflect.set(Reflect.get(manager, "database"), "vectorReady", null);
    await expect(
      (
        manager as unknown as {
          loadVectorExtension(): Promise<boolean>;
        }
      ).loadVectorExtension(),
    ).resolves.toBe(false);
    expect(db.prepare("SELECT vec_version() AS version").get()).toEqual({
      version: expect.any(String),
    });
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get()).toEqual({
      count: 2,
    });
    expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
  });
});
