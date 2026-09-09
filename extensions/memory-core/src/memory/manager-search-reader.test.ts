import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  ftsTableMatchesSchema,
  MEMORY_CHUNKING_VERSION,
  MEMORY_INDEX_FTS_COLUMNS,
  MEMORY_INDEX_FTS_TABLE,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { closeOpenClawAgentDatabasesForTest } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { resetMemoryDatabase } from "./manager-db.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import { markMemoryVectorRebuildRequired } from "./manager-vector-rebuild-state.js";
import {
  closeMemoryIndexManagersForAgent,
  MemoryIndexManager as RuntimeMemoryIndexManager,
} from "./manager.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("read-only memory search manager", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const { createConfig, provider, requireManager, trackManager } = fixture;

  function managerDb(manager: RuntimeMemoryIndexManager): DatabaseSync {
    return Reflect.get(manager, "db") as DatabaseSync;
  }

  async function getReader(cfg: Parameters<typeof getMemorySearchManager>[0]["cfg"]) {
    const result = await getMemorySearchManager({ cfg, agentId: "main", purpose: "search" });
    return requireManager(result, result.error);
  }

  function readMeta(db: DatabaseSync): MemoryIndexMeta {
    const row = db
      .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_index_meta_v1'")
      .get() as { value?: unknown } | undefined;
    if (typeof row?.value !== "string") {
      throw new Error("fixture index metadata is missing");
    }
    return JSON.parse(row.value) as MemoryIndexMeta;
  }

  it("prepares a fresh index through a writer, then reuses a query-only reader without writes", async () => {
    const cfg = createConfig({ provider: "none", vectorEnabled: false });
    const syncSpy = vi.spyOn(RuntimeMemoryIndexManager.prototype, "sync");
    const getSpy = vi.spyOn(RuntimeMemoryIndexManager, "get");
    try {
      const first = await getReader(cfg);
      trackManager(first);
      expect(await first.search("alpha", { minScore: 0 })).not.toEqual([]);
      expect(syncSpy).toHaveBeenCalledWith({ reason: "search", force: true });
      expect(managerDb(first).prepare("PRAGMA query_only").get()).toEqual({ query_only: 1 });
      expect(() => managerDb(first).exec("DELETE FROM memory_index_meta")).toThrow();
      await expect(first.sync({ force: true })).rejects.toThrow(/read-only/iu);

      const writer = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
      await writer.close();

      syncSpy.mockClear();
      getSpy.mockClear();
      const dbPath = first.status().dbPath;
      if (!dbPath) {
        throw new Error("fixture database path is missing");
      }
      const before = await fs.stat(dbPath);
      await fs.writeFile(
        path.join(fixture.paths.memory, "2026-01-12.md"),
        "# Log\nAlpha memory line.\nFresh-file-token memory line.",
      );

      const second = await getReader(cfg);
      expect(second).toBe(first);
      await expect(second.search("alpha", { minScore: 0 })).resolves.not.toEqual([]);
      await expect(second.search("fresh-file-token", { minScore: 0 })).resolves.toEqual([]);
      const after = await fs.stat(dbPath);

      expect(syncSpy).not.toHaveBeenCalled();
      expect(getSpy).not.toHaveBeenCalledWith(expect.objectContaining({ purpose: "maintenance" }));
      expect({ size: after.size, mtimeMs: after.mtimeMs }).toEqual({
        size: before.size,
        mtimeMs: before.mtimeMs,
      });
    } finally {
      syncSpy.mockRestore();
      getSpy.mockRestore();
    }
  });

  it("recovers a reset index through the existing writer before returning the reader", async () => {
    const cfg = createConfig({ provider: "none", vectorEnabled: false });
    const writer = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(writer);
    await writer.sync({ reason: "test", force: true });
    const reader = await getReader(cfg);
    trackManager(reader);
    const dbPath = writer.status().dbPath;
    if (!dbPath) {
      throw new Error("fixture database path is missing");
    }

    expect(
      await resetMemoryDatabase({
        targetDb: managerDb(writer),
        dbPath,
        workspaceDir: fixture.paths.workspace,
      }),
    ).toBe(true);
    const syncSpy = vi.spyOn(writer, "sync");
    const recovered = await getReader(cfg);

    expect(await recovered.search("alpha", { minScore: 0 })).not.toEqual([]);
    expect(syncSpy).toHaveBeenCalledWith({ reason: "search", force: true });
    expect(recovered.status().custom?.indexIdentity).toEqual({ status: "valid" });
  });

  it("repairs prior-version identity through a writer before returning the reader", async () => {
    const cfg = createConfig({ provider: "none", vectorEnabled: false });
    const writer = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    trackManager(writer);
    await writer.sync({ reason: "test", force: true });
    const db = managerDb(writer);
    const meta = readMeta(db);
    db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = 'memory_index_meta_v1'").run(
      JSON.stringify({ ...meta, chunkingVersion: MEMORY_CHUNKING_VERSION - 1 }),
    );
    const syncSpy = vi.spyOn(writer, "sync");

    const reader = await getReader(cfg);
    trackManager(reader);

    expect(syncSpy).toHaveBeenCalledWith({ reason: "search", force: true });
    expect(readMeta(db).chunkingVersion).toBe(MEMORY_CHUNKING_VERSION);
    expect(await reader.search("alpha", { minScore: 0 })).not.toEqual([]);
  });

  it.each([
    ["ordinary table", "CREATE TABLE memory_index_chunks_fts(wrong TEXT)"],
    ["wrong columns", "CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(wrong)"],
    [
      "contentless table",
      "CREATE VIRTUAL TABLE memory_index_chunks_fts USING fts5(text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED, start_line UNINDEXED, end_line UNINDEXED, content='')",
    ],
  ])("repairs a %s rejected by the canonical FTS validator", async (_name, definition) => {
    const cfg = createConfig({ provider: "none", vectorEnabled: false });
    const writer = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    await writer.sync({ reason: "test", force: true });
    const dbPath = writer.status().dbPath;
    if (!dbPath) {
      throw new Error("fixture database path is missing");
    }
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    const corrupt = new DatabaseSync(dbPath);
    corrupt.exec(`DROP TABLE ${MEMORY_INDEX_FTS_TABLE}; ${definition};`);
    corrupt.close();

    const reader = await getReader(cfg);
    trackManager(reader);
    expect(await reader.search("alpha", { minScore: 0 })).not.toEqual([]);
    expect(
      ftsTableMatchesSchema({
        db: managerDb(reader),
        tableName: MEMORY_INDEX_FTS_TABLE,
        expectedColumns: MEMORY_INDEX_FTS_COLUMNS,
        tokenizeClause: "",
      }),
    ).toBe("matching");
  });

  it("adopts a configured fallback index before validating reader identity", async () => {
    const cfg = createConfig({ fallback: "fallback-provider", model: "new-embed" });
    const publisher = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    const fields = publisher as unknown as {
      providerInitialized: boolean;
      provider: {
        id: string;
        model: string;
        embed: (text: string) => Promise<number[]>;
        embedBatch: (texts: string[]) => Promise<number[][]>;
        close: () => Promise<void>;
      };
    };
    fields.providerInitialized = true;
    fields.provider = {
      id: "mock",
      model: "new-embed",
      embed: async () => {
        throw provider.createLocalWorkerExitError();
      },
      embedBatch: async () => {
        throw provider.createLocalWorkerExitError();
      },
      close: async () => undefined,
    };
    await publisher.sync({ reason: "search", force: true });
    const requestedPrimary = (publisher as unknown as { settings: { provider: string } }).settings
      .provider;
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();
    provider.providerCreationFailure = requestedPrimary;
    const callsBeforeReader = provider.providerCalls.length;
    const syncSpy = vi.spyOn(RuntimeMemoryIndexManager.prototype, "sync");
    try {
      const reader = await getReader(cfg);
      trackManager(reader);
      expect(reader.status()).toMatchObject({
        provider: "fallback-provider",
        model: "fallback-provider-embed",
        custom: { indexIdentity: { status: "valid" } },
      });
      expect(await reader.search("alpha", { minScore: 0 })).not.toEqual([]);
      expect(syncSpy).not.toHaveBeenCalled();
      expect(provider.providerCalls.slice(callsBeforeReader)).toEqual([
        expect.objectContaining({ provider: "fallback-provider" }),
      ]);
    } finally {
      provider.providerCreationFailure = null;
      syncSpy.mockRestore();
    }
  });

  it("keeps keyword and stored-embedding cosine search available with native-vector debt", async () => {
    const cfg = createConfig({ vectorEnabled: true });
    const writer = requireManager(await getMemorySearchManager({ cfg, agentId: "main" }));
    await writer.sync({ reason: "test", force: true });
    markMemoryVectorRebuildRequired(managerDb(writer));
    await closeAllMemorySearchManagers();
    closeOpenClawAgentDatabasesForTest();

    const reader = await getReader(cfg);
    trackManager(reader);
    const keyword = await reader.search("alpha", { lexicalOnly: true, minScore: 0 });
    const cosine = await reader.search("beta", { minScore: 0 });

    expect(keyword).not.toEqual([]);
    expect(cosine).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
    );
    expect(reader.status().vector?.index).toEqual({ state: "incomplete" });
  });

  it("serializes global close with an in-flight reader replacement", async () => {
    const oldCfg = createConfig({ provider: "none", model: "old-model", vectorEnabled: false });
    const oldReader = await getReader(oldCfg);
    trackManager(oldReader);
    const originalClose = oldReader.close.bind(oldReader);
    let releaseClose: () => void = () => undefined;
    let notifyCloseStarted: () => void = () => undefined;
    const closeGate = new Promise<void>((resolve) => {
      releaseClose = resolve;
    });
    const closeStarted = new Promise<void>((resolve) => {
      notifyCloseStarted = resolve;
    });
    oldReader.close = async () => {
      notifyCloseStarted();
      await closeGate;
      await originalClose();
    };

    const newCfg = createConfig({ provider: "none", model: "new-model", vectorEnabled: false });
    const replacementPromise = getReader(newCfg);
    await closeStarted;
    const globalClose = closeAllMemorySearchManagers();
    let globalCloseSettled = false;
    void globalClose.finally(() => {
      globalCloseSettled = true;
    });
    await Promise.resolve();
    expect(globalCloseSettled).toBe(false);

    releaseClose();
    const replacement = await replacementPromise;
    trackManager(replacement);
    await globalClose;
    expect((replacement as unknown as { closed: boolean }).closed).toBe(true);
  });

  it("retains a failed replacement candidate until scoped cleanup retries", async () => {
    const oldCfg = createConfig({ provider: "none", model: "old-model", vectorEnabled: false });
    const oldReader = await getReader(oldCfg);
    trackManager(oldReader);
    const originalClose = Reflect.get(
      RuntimeMemoryIndexManager.prototype,
      "close",
    ) as RuntimeMemoryIndexManager["close"];
    let failedOldClose = false;
    let failedCandidateClose = false;
    const retainedCandidates: RuntimeMemoryIndexManager[] = [];
    const closeSpy = vi
      .spyOn(RuntimeMemoryIndexManager.prototype, "close")
      .mockImplementation(async function (this: RuntimeMemoryIndexManager) {
        const model = (this as unknown as { settings: { model: string } }).settings.model;
        if (this === oldReader && !failedOldClose) {
          failedOldClose = true;
          throw new Error("old reader close failed");
        }
        if (model === "new-model" && !failedCandidateClose) {
          failedCandidateClose = true;
          retainedCandidates.push(this);
          throw new Error("candidate close failed");
        }
        await originalClose.call(this);
      });

    try {
      const newCfg = createConfig({ provider: "none", model: "new-model", vectorEnabled: false });
      const replacement = await getReader(newCfg);
      trackManager(replacement);
      expect(replacement).not.toBe(oldReader);
      const retainedCandidate = retainedCandidates[0];
      expect(retainedCandidate).toBeDefined();
      expect((retainedCandidate as unknown as { closed: boolean }).closed).toBe(false);

      await closeMemoryIndexManagersForAgent({ agentId: "main" });

      expect((retainedCandidate as unknown as { closed: boolean }).closed).toBe(true);
      expect((replacement as unknown as { closed: boolean }).closed).toBe(true);
    } finally {
      closeSpy.mockRestore();
    }
  });

  it("retries writer preparation after a transient acquisition failure", async () => {
    const cfg = createConfig({ provider: "openai", vectorEnabled: false });
    provider.providerCreationFailure = "openai";

    await expect(
      getMemorySearchManager({ cfg, agentId: "main", purpose: "search" }),
    ).resolves.toMatchObject({
      manager: null,
      error: expect.stringContaining("provider creation failed"),
    });

    provider.providerCreationFailure = null;
    const reader = await getReader(cfg);
    trackManager(reader);
    expect(await reader.search("alpha", { minScore: 0 })).not.toEqual([]);
    expect(reader.status().custom?.indexIdentity).toEqual({ status: "valid" });
  });

  it("keeps the current reader alive when replacement acquisition fails, then recovers", async () => {
    const oldCfg = createConfig({ provider: "openai", model: "old-model" });
    const oldWriter = requireManager(
      await getMemorySearchManager({ cfg: oldCfg, agentId: "main" }),
    );
    await oldWriter.sync({ reason: "test", force: true });
    const oldReader = await getReader(oldCfg);
    trackManager(oldReader);

    provider.providerCreationFailure = "openai";
    const newCfg = createConfig({ provider: "openai", model: "new-model" });
    await expect(
      getMemorySearchManager({ cfg: newCfg, agentId: "main", purpose: "search" }),
    ).resolves.toMatchObject({
      manager: null,
      error: expect.stringContaining("provider creation failed"),
    });
    provider.providerCreationFailure = null;

    const oldAgain = await getReader(oldCfg);
    expect(oldAgain).toBe(oldReader);
    expect(await oldAgain.search("alpha", { minScore: 0 })).not.toEqual([]);

    const replacement = await getReader(newCfg);
    trackManager(replacement);
    expect(replacement).not.toBe(oldReader);
    expect((oldReader as unknown as { closed: boolean }).closed).toBe(true);
  });
});
