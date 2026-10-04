import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  encodeMemoryEmbedding,
  INVALID_PROJECT_ANNOTATION_KEY,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { deleteSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { writeMemoryIndexArchiveTranscript } from "./index-archive.test-support.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryTargetedSessionSyncQueue } from "./manager-sync-control.js";
import type { MemoryIndexManager } from "./manager.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

function sessionTarget(sessionId: string, sessionKey: string) {
  return { agentId: "main", sessionId, sessionKey };
}

describe("memory index", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const {
    provider: providerFixture,
    createConfig: createCfg,
    getFreshManager,
    getFtsSessionManager,
    getPersistentManager,
    seedSessionTranscript: seedMemoryIndexSessionTranscript,
  } = fixture;

  it("reindexes memory tables in place without deleting unrelated agent rows", async () => {
    const agentDbPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const agentDb = openOpenClawAgentDatabase({ agentId: "main" });
    agentDb.db
      .prepare("INSERT INTO cache_entries (scope, key, value_json, updated_at) VALUES (?, ?, ?, ?)")
      .run("test", "keep-me", JSON.stringify({ value: "keep-me" }), 1);
    closeOpenClawAgentDatabasesForTest();

    const manager = await getFreshManager(createCfg({}));
    try {
      await manager.sync({ reason: "test", force: true });
      expect(manager.status().dbPath).toBe(agentDbPath);
    } finally {
      await manager.close?.();
    }

    const reopened = openOpenClawAgentDatabase({ agentId: "main" });
    expect(
      reopened.db
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
        .get("test", "keep-me"),
    ).toEqual({
      value_json: JSON.stringify({ value: "keep-me" }),
    });
  });

  const writeMemory = (filename: string, content: string) =>
    fs.writeFile(path.join(fixture.paths.memory, filename), content);

  async function seedSession(
    sessionId: string,
    content: string,
    options: { role: "user" | "assistant"; timestamp: number | string; sessionKey?: string },
  ) {
    const { sessionKey, ...message } = options;
    await seedMemoryIndexSessionTranscript({
      sessionId,
      sessionKey,
      messages: [{ ...message, content }],
    });
  }

  async function getReconfiguredSessionManager(sources: Array<"memory" | "sessions">) {
    const config = { sources, sessionMemory: true, model: "old-embed" };
    const previous = await getFreshManager(createCfg(config));
    await previous.sync({ reason: "test", force: true });
    await previous.close();
    return getFreshManager(createCfg({ ...config, provider: "gemini", model: "new-embed" }));
  }

  it("rebuilds a missing vector table through forced sync with cached readiness", async () => {
    const manager = await getFreshManager(createCfg({ vectorEnabled: true }));
    await manager.sync({ reason: "test", force: true });
    const db = Reflect.get(manager, "db") as DatabaseSync;
    expect(db.prepare("SELECT COUNT(*) AS count FROM memory_index_chunks_vec").get()).toEqual({
      count: 1,
    });
    await expect(manager.probeVectorAvailability()).resolves.toBe(true);
    expect(manager.status().vector).toMatchObject({ storeAvailable: true, dims: 4 });
    db.exec("DROP TABLE memory_index_chunks_vec");
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name = 'memory_index_chunks_vec'").get(),
    ).toBeUndefined();

    await manager.sync({ reason: "test", force: true });
    const chunks = db.prepare("SELECT id, text FROM memory_index_chunks ORDER BY id").all();
    expect(chunks).toEqual([
      { id: expect.any(String), text: expect.stringContaining("Alpha memory line.") },
    ]);
    expect(db.prepare("SELECT id FROM memory_index_chunks_vec ORDER BY id").all()).toEqual(
      chunks.map(({ id }) => ({ id })),
    );
    expect(await manager.search("alpha")).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
    );
  });

  it("round-trips mixed-case project keys through indexed recall consumers", async () => {
    const projectKey = "github.com/OpenClaw/OpenClaw";
    await fs.writeFile(
      path.join(fixture.paths.workspace, "MEMORY.md"),
      `- Follow the kraken deploy ritual. <!-- trigger: kraken deploy ritual --> <!-- importance: 8 --> <!-- project: ${projectKey} -->\n`,
    );

    const manager = await getFreshManager(createCfg({}));
    await manager.sync({ reason: "test", force: true });
    const db = Reflect.get(manager, "db") as DatabaseSync;
    expect(
      db
        .prepare(
          `SELECT metadata.project_key AS projectKey
           FROM memory_index_chunks AS chunk
           JOIN memory_index_chunk_recall_metadata AS metadata
             ON metadata.chunk_id = chunk.id
           WHERE chunk.path = 'MEMORY.md'
             AND metadata.triggers = 'kraken deploy ritual'`,
        )
        .get(),
    ).toEqual({ projectKey });

    const activeProjectKeys = [projectKey];
    const curated = await manager.listCuratedProjectCandidates({ activeProjectKeys });
    const triggers = await manager.listTriggerCandidates({ activeProjectKeys });
    const expectedCandidates = [
      {
        projectKey,
        triggers: "kraken deploy ritual",
        provenance: { originClass: "agent" },
      },
    ];
    expect(curated).toMatchObject(expectedCandidates);
    expect(triggers).toMatchObject(expectedCandidates);

    const neutral = await manager.search("kraken deploy", {
      minScore: 0,
      maxResults: 10,
      activeProjectKeys: [],
    });
    const active = await manager.search("kraken deploy", {
      minScore: 0,
      maxResults: 10,
      activeProjectKeys,
    });
    const neutralHit = neutral.find((entry) => entry.projectKey === projectKey);
    const activeHit = active.find((entry) => entry.projectKey === projectKey);
    assert.ok(neutralHit && activeHit, "expected neutral and active project hits");
    expect(activeHit.score).toBeGreaterThan(neutralHit.score);
  });

  it("keeps quarantined curated memory searchable but out of automatic candidates", async () => {
    const projectKey = "github.com/openclaw/openclaw";
    await fs.writeFile(
      path.join(fixture.paths.workspace, "MEMORY.md"),
      `- Quarantined release instruction. <!-- trigger: release instruction --> <!-- project: ${projectKey} -->\n`,
    );
    const manager = await getFreshManager(createCfg({ provider: "none" }));
    await manager.sync({ reason: "test", force: true });
    const db = Reflect.get(manager, "db") as DatabaseSync;
    db.prepare(
      `UPDATE ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE}
       SET origin_class = 'untrusted'
       WHERE chunk_id IN (
         SELECT id FROM memory_index_chunks WHERE path = 'MEMORY.md' AND source = 'memory'
       )`,
    ).run();
    await expect(
      manager.listCuratedProjectCandidates({ activeProjectKeys: [projectKey] }),
    ).resolves.toEqual([]);
    await expect(
      manager.listTriggerCandidates({ activeProjectKeys: [projectKey] }),
    ).resolves.toEqual([]);

    const explicit = await manager.search("Quarantined release instruction", {
      lexicalOnly: true,
      minScore: 0,
      maxResults: 10,
      sources: ["memory"],
    });
    expect(explicit).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provenance: expect.objectContaining({ originClass: "untrusted" }),
        }),
      ]),
    );
  });

  it("keeps invalid project annotations scoped but unsatisfiable", async () => {
    await fs.writeFile(
      path.join(fixture.paths.workspace, "MEMORY.md"),
      [
        "- Invalid fact. <!-- trigger: invalid fact --> <!-- project: bad< -->",
        "- Mixed fact. <!-- trigger: mixed fact --> <!-- project: alpha-key; bad< -->",
        "- Unterminated fact. <!-- trigger: unterminated fact --> <!-- project: alpha-key",
        "- Global fact. <!-- trigger: global fact -->",
      ].join("\n"),
    );
    const manager = await getFreshManager(createCfg({ provider: "none" }));
    await manager.sync({ reason: "test", force: true });
    const db = Reflect.get(manager, "db") as DatabaseSync;
    expect(
      db
        .prepare(
          `SELECT metadata.triggers, metadata.project_key AS projectKey
           FROM memory_index_chunks AS chunk
           LEFT JOIN memory_index_chunk_recall_metadata AS metadata
             ON metadata.chunk_id = chunk.id
           WHERE chunk.path = 'MEMORY.md'
           ORDER BY chunk.start_line`,
        )
        .all(),
    ).toEqual([
      { triggers: "invalid fact", projectKey: INVALID_PROJECT_ANNOTATION_KEY },
      { triggers: "mixed fact", projectKey: INVALID_PROJECT_ANNOTATION_KEY },
      { triggers: null, projectKey: INVALID_PROJECT_ANNOTATION_KEY },
      { triggers: "global fact", projectKey: null },
    ]);
    const activeProjectKeys = ["alpha-key"];
    const triggerCandidates = await manager.listTriggerCandidates({ activeProjectKeys });
    expect(triggerCandidates).toMatchObject([{ triggers: "global fact" }]);
    const results = await manager.search("fact", {
      minScore: 0,
      maxResults: 10,
      activeProjectKeys,
    });
    expect(
      results.every((entry) => !/Invalid fact|Mixed fact|Unterminated fact/u.test(entry.snippet)),
    ).toBe(true);
  });

  it("keeps indexed memory searchable when source discovery fails", async () => {
    const memoryPath = path.join(fixture.paths.workspace, "MEMORY.md");
    const query = "harbor seal migration ritual";
    await fs.writeFile(memoryPath, `Remember the ${query}.\n`);
    const manager = await getFreshManager(createCfg({}));
    await manager.sync({ reason: "test", force: true });
    await expect(manager.search(query)).resolves.toEqual([
      expect.objectContaining({ path: "MEMORY.md" }),
    ]);

    const scanError = Object.assign(new Error("workspace scan failed"), { code: "EIO" });
    const realReaddir = fs.readdir;
    const readdirSpy = vi
      .spyOn(fs, "readdir")
      .mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        if (path.resolve(String(args[0])) === fixture.paths.workspace) {
          throw scanError;
        }
        return await realReaddir(...args);
      });
    try {
      await expect(manager.sync({ reason: "cli", force: true })).rejects.toThrow(
        "memory source scan failed",
      );
    } finally {
      readdirSpy.mockRestore();
    }

    await expect(manager.search(query)).resolves.toEqual([
      expect.objectContaining({ path: "MEMORY.md" }),
    ]);
  });

  it("reports an uninitialized status without creating agent or registry databases", async () => {
    const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const statePath = path.join(fixture.paths.stateDir, "state", "openclaw.sqlite");

    const result = await getMemorySearchManager({
      cfg: createCfg({}),
      agentId: "main",
      purpose: "status",
      inspectSources: true,
    });

    try {
      expect(result.error).toBeUndefined();
      expect(result.manager?.status()).toMatchObject({
        files: 0,
        chunks: 0,
        dirty: true,
        custom: { indexIdentity: { status: "missing" } },
      });
      await expect(fs.access(agentPath)).rejects.toThrow("ENOENT");
      await expect(fs.access(statePath)).rejects.toThrow("ENOENT");
    } finally {
      await result.manager?.close?.();
    }
  });

  it("reads committed WAL status without changing database artifacts", async () => {
    const cfg = createCfg({});
    const indexingManager = await getFreshManager(cfg, "cli");
    await indexingManager.sync({ reason: "test", force: true });
    await indexingManager.close?.();

    const agentPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const writer = new DatabaseSync(agentPath);
    let statusManager: MemoryIndexManager | undefined;
    try {
      writer.exec("PRAGMA wal_autocheckpoint = 0; PRAGMA wal_checkpoint(TRUNCATE);");
      writer
        .prepare("UPDATE memory_index_sources SET hash = ? WHERE path = ? AND source = 'memory'")
        .run("committed-in-wal", "memory/2026-01-12.md");
      const databaseBefore = await fs.readFile(agentPath);
      const walBefore = await fs.readFile(`${agentPath}-wal`);

      statusManager = await getFreshManager(cfg, "status", true);
      expect(statusManager.status().dirty).toBe(true);
      await statusManager.close?.();
      statusManager = undefined;

      assert.deepStrictEqual(await fs.readFile(agentPath), databaseBefore);
      assert.deepStrictEqual(await fs.readFile(`${agentPath}-wal`), walBefore);
    } finally {
      await statusManager?.close?.();
      writer.close();
    }
  });

  it("maps source-wide batch fallback results to missing chunks after cache hits", async () => {
    const manager = await getFreshManager(
      createCfg({ provider: "batch-wide-test", batchEnabled: true }),
    );
    await manager.sync({ reason: "test" });

    await writeMemory("2026-01-13.md", "# Log\nBeta memory line.");
    providerFixture.providerRuntimeBatchCalls = [];
    providerFixture.providerRuntimeBatchFailuresRemaining = 1;
    providerFixture.embedBatchCalls = 0;

    await manager.sync({ reason: "test", force: true });

    expect(providerFixture.providerRuntimeBatchCalls).toEqual([["# Log\nBeta memory line."]]);
    expect(providerFixture.embedBatchCalls).toBe(1);
    const betaRow = (Reflect.get(manager, "db") as DatabaseSync)
      .prepare("SELECT embedding FROM memory_index_chunks WHERE path LIKE ? AND source = ?")
      .get("%2026-01-13.md", "memory") as { embedding: Uint8Array } | undefined;

    expect(betaRow).toBeDefined();
    expect(betaRow?.embedding).toEqual(encodeMemoryEmbedding([0, 1, 0, 0]));
  });

  it("counts local batch attempts and bypasses batching after repeated failures", async () => {
    providerFixture.providerRuntimeBatchErrors = [
      Object.assign(new Error("provider runtime batch failed"), {
        batchAttempts: Number.MAX_SAFE_INTEGER,
      }),
    ];
    const manager = await getFreshManager(
      createCfg({ provider: "batch-wide-test", batchEnabled: true }),
    );
    await manager.sync({ reason: "test" });

    expect(providerFixture.providerRuntimeBatchCalls).toHaveLength(1);
    expect(providerFixture.embedBatchCalls).toBe(1);
    expect(manager.status().batch).toMatchObject({
      enabled: true,
      failures: 1,
      lastError: "provider runtime batch failed",
    });

    for (const day of [13, 14]) {
      await writeMemory(`2026-01-${day}.md`, `# Log\nBeta memory line ${day}.`);
      providerFixture.providerRuntimeBatchErrors = [new Error("second batch failure")];
      await manager.sync({ reason: "test", force: true });
      expect(providerFixture.providerRuntimeBatchCalls).toHaveLength(2);
      expect(providerFixture.embedBatchCalls).toBe(day - 11);
      expect(manager.status().batch).toMatchObject({
        enabled: false,
        failures: 2,
        lastError: "second batch failure",
        lastProvider: "batch-wide-test",
      });
    }
  });

  it("disables batch immediately when the provider reports it unavailable", async () => {
    providerFixture.providerRuntimeBatchErrors = [
      Object.assign(new Error("provider batch unavailable"), {
        code: "embedding_batch_unavailable",
      }),
    ];
    const manager = await getFreshManager(
      createCfg({ provider: "batch-wide-test", batchEnabled: true }),
    );
    await manager.sync({ reason: "test" });

    expect(providerFixture.providerRuntimeBatchCalls).toHaveLength(1);
    expect(providerFixture.embedBatchCalls).toBe(1);
    expect(manager.status().batch).toMatchObject({
      enabled: false,
      failures: 2,
      lastError: "provider batch unavailable",
    });
  });

  it("preserves frozen errors while recording both attempts", async () => {
    providerFixture.providerRuntimeBatchErrors = [
      new Error("memory embeddings batch timed out"),
      Object.freeze(new Error("provider runtime retry failed")),
    ];
    const manager = await getFreshManager(
      createCfg({ provider: "batch-wide-test", batchEnabled: true }),
    );
    await manager.sync({ reason: "test" });

    expect(providerFixture.providerRuntimeBatchCalls).toHaveLength(2);
    expect(providerFixture.embedBatchCalls).toBe(1);
    expect(manager.status().batch).toMatchObject({
      enabled: false,
      failures: 2,
      lastError: "provider runtime retry failed",
    });
  });

  it("resets batch failures when a timeout retry recovers", async () => {
    providerFixture.providerRuntimeBatchErrors = [new Error("provider runtime batch failed")];
    const manager = await getFreshManager(
      createCfg({ provider: "batch-wide-test", batchEnabled: true }),
    );
    await manager.sync({ reason: "test" });
    expect(manager.status().batch?.failures).toBe(1);

    await writeMemory("2026-01-13.md", "# Log\nBeta memory line.");
    providerFixture.providerRuntimeBatchCalls = [];
    providerFixture.providerRuntimeBatchErrors = [new Error("memory embeddings batch timed out")];
    providerFixture.embedBatchCalls = 0;

    await manager.sync({ reason: "test", force: true });

    expect(providerFixture.providerRuntimeBatchCalls).toHaveLength(2);
    expect(providerFixture.embedBatchCalls).toBe(0);
    expect(manager.status().batch).toMatchObject({
      enabled: true,
      failures: 0,
      lastError: undefined,
    });
  });

  it.for([
    ["late failure", 1, 2, { enabled: false, failures: 2, lastError: "failure 1" }],
    ["late recovery", 1, 1, { enabled: false, failures: 0, lastError: undefined }],
  ] as const)(
    "keeps custom batches concurrent through %s",
    async ([_outcome, priorFailures, errors, expected], { signal }) => {
      const manager = await getFreshManager(
        createCfg({ provider: "batch-test", batchEnabled: true }),
      );
      providerFixture.providerRuntimeBatchFailuresRemaining = priorFailures;
      await manager.sync({ reason: "test" });
      expect(manager.status().batch?.failures).toBe(priorFailures);

      await writeMemory("2026-01-13.md", "# Log\nBeta memory line.");
      await writeMemory("2026-01-14.md", "# Log\nGamma memory line.");
      providerFixture.providerRuntimeBatchCalls = [];
      providerFixture.providerRuntimeMaxActiveBatchCalls = 0;
      providerFixture.embedBatchCalls = 0;
      providerFixture.providerRuntimeBatchErrors = Array.from(
        { length: errors },
        (_, index) => new Error(`failure ${index + 1}`),
      );
      const batchesEntered = createDeferred<void>();
      const releaseBatchGate = createDeferred<void>();
      providerFixture.providerRuntimeBatchGate = releaseBatchGate.promise;
      providerFixture.providerRuntimeBatchEntered = (activeCalls) => {
        if (activeCalls === 2) {
          batchesEntered.resolve();
        }
      };
      const abort = () => batchesEntered.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      const syncPromise = manager.sync({ reason: "test", force: true });
      try {
        // Provider entry owns this rendezvous; filesystem preparation has no one-second contract.
        signal.throwIfAborted();
        await Promise.race([batchesEntered.promise, syncPromise]);
        expect(providerFixture.providerRuntimeMaxActiveBatchCalls).toBe(2);
      } finally {
        signal.removeEventListener("abort", abort);
        providerFixture.providerRuntimeBatchEntered = null;
        releaseBatchGate.resolve();
        await syncPromise;
      }
      expect(manager.status().batch).toMatchObject(expected);
      expect(providerFixture.providerRuntimeBatchCalls).toHaveLength(2);
      expect(providerFixture.embedBatchCalls).toBe(errors);
    },
  );

  it("batches forced memory and session indexing across files", async () => {
    await writeMemory("2026-01-13.md", "# Log\nBeta memory line.");
    await seedSession("session-alpha", "Session alpha memory line.", {
      role: "user",
      timestamp: "2026-04-07T15:25:04.113Z",
    });
    await seedSession("session-beta", "Session beta memory line.", {
      role: "assistant",
      timestamp: "2026-04-07T15:25:04.113Z",
    });
    const cfg = createCfg({
      provider: "batch-wide-test",
      batchEnabled: true,
      sources: ["memory", "sessions"],
      sessionMemory: true,
    });
    const manager = await getFreshManager(cfg);
    await manager.sync({ reason: "cli", force: true });

    expect(providerFixture.providerRuntimeBatchCalls).toHaveLength(1);
    const combinedBatch = providerFixture.providerRuntimeBatchCalls[0] ?? [];
    expect(combinedBatch.slice(0, 2)).toEqual([
      "# Log\nAlpha memory line.\nZebra memory line.",
      "# Log\nBeta memory line.",
    ]);
    expect(combinedBatch.join("\n")).toContain("Session alpha memory line.");
    expect(combinedBatch.join("\n")).toContain("Session beta memory line.");
  });

  it("keeps status clean when configured model defaults to the adapter model (#90413)", async () => {
    const indexManager = await getFreshManager(
      createCfg({ provider: "gemini", model: "gemini-embed" }),
    );
    await indexManager.sync({ reason: "test", force: true });
    await indexManager.close?.();

    const statusManager = await getFreshManager(
      createCfg({ provider: "gemini", model: "" }),
      "status",
    );
    const status = statusManager.status();

    expect(status.dirty).toBe(false);
    expect(status.custom?.indexIdentity).toEqual({ status: "valid" });
  });

  it("rebuilds missing metadata with existing chunks before search", async () => {
    const cfg = createCfg({});
    await fs.writeFile(path.join(fixture.paths.workspace, "USER.md"), "Beta memory line.");
    const oldManager = await getFreshManager(cfg);
    await oldManager.sync({ reason: "test", force: true });
    await oldManager.close?.();
    await fs.rm(path.join(fixture.paths.memory, "2026-01-12.md"));

    const nextManager = await getFreshManager(cfg);
    (Reflect.get(nextManager, "db") as DatabaseSync).exec(
      `DELETE FROM memory_index_meta WHERE key = 'memory_index_meta_v1'`,
    );
    expect(nextManager.status().custom?.indexIdentity).toEqual({
      status: "missing",
      reason: "index metadata is missing",
      code: "metadata_missing",
      owner: "openclaw",
    });

    const results = await nextManager.search("alpha");

    expect(nextManager.status().dirty).toBe(false);
    expect(nextManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
    expect(results.some((result) => result.path.endsWith("memory/2026-01-12.md"))).toBe(false);
    expect(results.some((result) => result.path === "USER.md")).toBe(true);
  });

  it("does not rebuild missing semantic metadata when embeddings are unavailable", async () => {
    const oldCfg = createCfg({
      model: "semantic-embed",
    });
    const oldManager = await getFreshManager(oldCfg);
    await oldManager.sync({ reason: "test", force: true });
    await oldManager.close?.();

    providerFixture.forceNoProvider = true;
    const nextManager = await getFreshManager(oldCfg);
    const db = Reflect.get(nextManager, "db") as DatabaseSync;
    db.exec(`DELETE FROM memory_index_meta WHERE key = 'memory_index_meta_v1'`);

    await nextManager.sync({ reason: "test" });

    expect(nextManager.status().dirty).toBe(true);
    expect(nextManager.status().custom?.indexIdentity).toEqual({
      status: "missing",
      reason: "index metadata is missing",
      code: "metadata_missing",
      owner: "openclaw",
    });
    const row = db.prepare("SELECT model FROM memory_index_chunks LIMIT 1").get();
    expect(row?.model).toBe("semantic-embed");
  });

  it("clears dirty after sessions-only identity reindex", async () => {
    await seedSession("session-identity", "Session-only identity marker.", {
      role: "assistant",
      timestamp: "2026-04-07T15:25:04.113Z",
    });

    const nextManager = await getReconfiguredSessionManager(["sessions"]);
    expect(nextManager.status().dirty).toBe(true);

    await nextManager.sync({ reason: "test", force: true });

    expect(nextManager.status().dirty).toBe(false);
    expect(nextManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
  });

  it("drains retained queued targets through the next idle sync call", async () => {
    const markers = {
      blocker: "BLOCKER FAILED SYNC 729",
      retained: "RETAINED RETRY TARGET 729",
      trigger: "IDLE TRIGGER TARGET 729",
    };
    const sessionKey = (sessionId: string) => `agent:main:proof:${sessionId}`;
    const manager = await getFreshManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
        sessionMemory: true,
      }),
      "cli",
    );
    const dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    const db = new DatabaseSync(dbPath);
    try {
      await manager.sync({ reason: "test-baseline", force: true });
      for (const [sessionId, marker] of Object.entries(markers)) {
        await seedSession(sessionId, marker, {
          role: "user",
          timestamp: Date.now(),
          sessionKey: sessionKey(sessionId),
        });
      }

      db.exec(`
        CREATE TRIGGER fail_queued_session_publication
        AFTER INSERT ON memory_index_chunks
        BEGIN
          SELECT RAISE(FAIL, 'forced queued session publication failure');
        END;
      `);

      const active = manager.sync({
        reason: "test-failed-owner",
        sessions: [sessionTarget("blocker", sessionKey("blocker"))],
      });
      const failedQueued = manager.sync({
        reason: "test-queued-retained",
        sessions: [sessionTarget("retained", sessionKey("retained"))],
      });
      const failures = await Promise.allSettled([active, failedQueued]);
      for (const result of failures) {
        expect(result.status).toBe("rejected");
        if (result.status !== "rejected") {
          throw new Error("expected failed SQLite publication to reject");
        }
        expect(result.reason).toMatchObject({
          message: "forced queued session publication failure",
        });
      }
      db.exec("DROP TRIGGER fail_queued_session_publication");

      const ftsMatchCount = (marker: string): number => {
        const observer = new DatabaseSync(dbPath, { readOnly: true });
        try {
          return (
            observer
              .prepare(
                "SELECT COUNT(*) AS count FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?",
              )
              .get(`"${marker}"`) as { count: number }
          ).count;
        } finally {
          observer.close();
        }
      };

      expect(ftsMatchCount(markers.retained)).toBe(0);
      expect(ftsMatchCount(markers.trigger)).toBe(0);
      // Hand ordinary dirty state to maintenance so recovery must use the retained queue.
      manager.takeReindexRetryStateForMaintenance();
      const recoveryState = manager as unknown as {
        syncing: Promise<void> | null;
        sessionSyncQueue: MemoryTargetedSessionSyncQueue;
        sessionsDirtyFiles: Set<string>;
        sessionsFullRetryDirty: boolean;
      };
      expect(recoveryState.syncing).toBeNull();
      expect(recoveryState.sessionSyncQueue.sessions.size).toBe(1);
      expect(recoveryState.sessionsDirtyFiles.size).toBe(0);
      expect(recoveryState.sessionsFullRetryDirty).toBe(false);

      const recoveryProgress = vi.fn();
      const recovery = manager.sync({
        reason: "test-recovery-trigger",
        sessions: [sessionTarget("trigger", sessionKey("trigger"))],
        progress: recoveryProgress,
      });
      // A full sync can claim `syncing` before the retained queue owner resumes.
      // Both owners must settle without the queue awaiting its own promise.
      const competingFullSync = manager.sync({ reason: "test-competing-full-sync" });
      const recoveryResults = await Promise.allSettled([recovery, competingFullSync]);
      expect(recoveryResults.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);

      expect(ftsMatchCount(markers.retained)).toBeGreaterThan(0);
      expect(ftsMatchCount(markers.trigger)).toBeGreaterThan(0);
      expect(recoveryState.sessionSyncQueue.sessions.size).toBe(0);
      expect(recoveryProgress).toHaveBeenCalled();
    } finally {
      db.close();
      await manager.close?.();
    }
  });

  it("drains retained queued targets from a live rejection transition", async () => {
    const markers = {
      retained: "LIVE REJECTION RETAINED TARGET 729",
      transition: "LIVE REJECTION TRANSITION TARGET 729",
      trigger: "LIVE REJECTION RECOVERY TARGET 729",
    };
    const sessionKey = (sessionId: string) => `agent:main:live-rejection:${sessionId}`;
    // Startup catchup must not consume the controlled sync mocks.
    const manager = await getFreshManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
        sessionMemory: true,
      }),
      "cli",
    );
    const activeSyncGate = createDeferred<void>();
    const queuedSyncGate = createDeferred<void>();
    const owner = manager as unknown as {
      sessionSyncQueue: MemoryTargetedSessionSyncQueue;
      syncing: Promise<void> | null;
      runSync: (params?: MemorySyncParams) => Promise<void>;
    };
    const originalRunSync = owner.runSync.bind(owner);
    const runSyncSpy = vi
      .spyOn(owner, "runSync")
      .mockImplementationOnce(async (params) => await originalRunSync(params))
      .mockImplementationOnce(async () => await activeSyncGate.promise)
      .mockImplementationOnce(async () => await queuedSyncGate.promise)
      .mockImplementation(async (params) => await originalRunSync(params));
    const queuedError = new Error("controlled queued rejection");
    try {
      await manager.sync({ reason: "test-live-rejection-baseline", force: true });
      for (const [sessionId, marker] of Object.entries(markers)) {
        await seedSession(sessionId, marker, {
          role: "user",
          timestamp: Date.now(),
          sessionKey: sessionKey(sessionId),
        });
      }

      const active = manager.sync({
        reason: "test-live-rejection-owner",
        sessions: [sessionTarget("active", sessionKey("active"))],
      });
      const queuedProgress = vi.fn();
      const failedQueued = manager.sync({
        reason: "test-live-rejection-queued",
        sessions: [sessionTarget("retained", sessionKey("retained"))],
        force: true,
        progress: queuedProgress,
      });
      const failuresPromise = Promise.allSettled([active, failedQueued]);
      activeSyncGate.resolve();
      await vi.waitFor(() => {
        expect(runSyncSpy).toHaveBeenCalledTimes(3);
        expect(owner.syncing).not.toBeNull();
        expect(owner.sessionSyncQueue.pending).not.toBeNull();
      });
      const rejectingQueuedSync = owner.syncing;
      if (!rejectingQueuedSync) {
        throw new Error("expected a live queued sync");
      }

      const transitionResult = createDeferred<PromiseSettledResult<void>>();
      let transitionState:
        | { syncingNull: boolean; queueOwnerLive: boolean; queuedTargets: number }
        | undefined;
      const transitionProgress = vi.fn();
      void rejectingQueuedSync.catch(() => {
        transitionState = {
          syncingNull: owner.syncing === null,
          queueOwnerLive: owner.sessionSyncQueue.pending !== null,
          queuedTargets: owner.sessionSyncQueue.sessions.size,
        };
        const transitionCall = manager.sync({
          reason: "test-live-rejection-transition",
          sessions: [sessionTarget("transition", sessionKey("transition"))],
          progress: transitionProgress,
        });
        void transitionCall.then(
          (value) => transitionResult.resolve({ status: "fulfilled", value }),
          (reason: unknown) => transitionResult.resolve({ status: "rejected", reason }),
        );
      });

      queuedSyncGate.reject(queuedError);
      const failures = await failuresPromise;
      const transitionFailure = await transitionResult.promise;
      expect(failures[0]?.status).toBe("fulfilled");
      expect(failures[1]?.status).toBe("rejected");
      expect(transitionFailure.status).toBe("rejected");
      if (failures[1]?.status !== "rejected" || transitionFailure.status !== "rejected") {
        throw new Error("expected shared queued rejection");
      }
      expect(failures[1].reason).toBe(queuedError);
      expect(transitionFailure.reason).toBe(queuedError);
      expect(transitionState).toEqual({
        syncingNull: true,
        queueOwnerLive: true,
        queuedTargets: 0,
      });
      expect(Array.from(owner.sessionSyncQueue.sessions.values())).toEqual([
        sessionTarget("transition", sessionKey("transition")),
        sessionTarget("retained", sessionKey("retained")),
      ]);
      expect(queuedProgress).not.toHaveBeenCalled();
      expect(transitionProgress).not.toHaveBeenCalled();

      const recoveryProgress = vi.fn();
      await manager.sync({
        reason: "test-live-rejection-recovery",
        sessions: [sessionTarget("trigger", sessionKey("trigger"))],
        progress: recoveryProgress,
      });

      const dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const observer = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const indexedCount = (marker: string) =>
          (
            observer
              .prepare("SELECT COUNT(*) AS count FROM memory_index_chunks WHERE text LIKE ?")
              .get(`%${marker}%`) as { count: number }
          ).count;
        expect(indexedCount(markers.retained)).toBeGreaterThan(0);
        expect(indexedCount(markers.transition)).toBeGreaterThan(0);
        expect(indexedCount(markers.trigger)).toBeGreaterThan(0);
      } finally {
        observer.close();
      }
      expect(owner.sessionSyncQueue.sessions.size).toBe(0);
      expect(recoveryProgress).toHaveBeenCalled();
      expect(transitionProgress).not.toHaveBeenCalled();
    } finally {
      activeSyncGate.resolve();
      queuedSyncGate.reject(queuedError);
      await manager.close?.();
      runSyncSpy.mockRestore();
    }
  });

  it("clears retained queued targets when close interrupts a competing sync", async () => {
    const manager = await getFreshManager(
      createCfg({
        provider: "none",
        sources: ["sessions"],
        sessionMemory: true,
      }),
    );
    const fullSyncGate = createDeferred<void>();
    const owner = manager as unknown as {
      sessionSyncQueue: MemoryTargetedSessionSyncQueue;
      closing: boolean;
      closed: boolean;
      syncAdmitted: (params?: MemorySyncParams) => Promise<void>;
      runSync: (params?: MemorySyncParams) => Promise<void>;
    };
    const syncAdmitted = vi.spyOn(owner, "syncAdmitted");
    const runSyncSpy = vi.spyOn(owner, "runSync").mockReturnValueOnce(fullSyncGate.promise);
    const progress = vi.fn();
    owner.sessionSyncQueue.sessions.set("retained", {
      agentId: "main",
      sessionId: "retained-close",
      sessionKey: "agent:main:retained-close",
    });

    try {
      const recovery = manager.sync({
        reason: "test-close-recovery",
        sessions: [sessionTarget("trigger-close", "agent:main:trigger-close")],
        force: true,
        progress,
      });
      const competingFullSync = manager.sync({ reason: "test-close-competing-full-sync" });

      await vi.waitFor(() => {
        expect(syncAdmitted).toHaveBeenCalledTimes(2);
      });
      const closing = manager.close?.() ?? Promise.resolve();
      expect(owner.closing).toBe(true);
      fullSyncGate.resolve();

      await expect(Promise.all([recovery, competingFullSync, closing])).resolves.toEqual([
        undefined,
        undefined,
        undefined,
      ]);
      expect(runSyncSpy).toHaveBeenCalledTimes(1);
      expect(syncAdmitted).toHaveBeenCalledTimes(2);
      expect(owner.closed).toBe(true);
      expect(owner.sessionSyncQueue.sessions.size).toBe(0);
      expect(owner.sessionSyncQueue.progressCallbacks.size).toBe(0);
      expect(owner.sessionSyncQueue.force).toBe(false);
      expect(progress).not.toHaveBeenCalled();
    } finally {
      fullSyncGate.resolve();
      await manager.close?.();
      runSyncSpy.mockRestore();
      syncAdmitted.mockRestore();
    }
  });

  it("keeps provider cutover vector search paused during targeted session sync", async () => {
    const sessionFile = await writeMemoryIndexArchiveTranscript({
      sessionId: "session-targeted-cutover",
      text: "Targeted cutover marker.",
    });

    const nextManager = await getReconfiguredSessionManager(["memory", "sessions"]);
    expect(nextManager.status().dirty).toBe(true);
    providerFixture.embedBatchCalls = 0;

    await nextManager.sync({ reason: "test", archiveFiles: [sessionFile] });

    expect(providerFixture.embedBatchCalls).toBe(0);
    expect(nextManager.status().dirty).toBe(true);
    expect(nextManager.status().custom?.indexIdentity).toEqual({
      status: "mismatched",
      reason: "index was built for model old-embed, expected new-embed",
      code: "model",
      owner: "configuration",
    });
    const results = await nextManager.search("alpha");
    expect(results).toStrictEqual([]);
  });

  it("preserves memory dirty events raised during session identity reindex", async () => {
    await writeMemoryIndexArchiveTranscript({
      sessionId: "session-dirty-during-reindex",
      text: "Dirty during session marker.",
    });

    const nextManager = await getReconfiguredSessionManager(["memory", "sessions"]);
    const fields = nextManager as unknown as {
      dirty: boolean;
      syncArchiveFiles: (params: unknown) => Promise<void>;
    };
    const syncArchiveFiles = fields.syncArchiveFiles.bind(nextManager);
    fields.syncArchiveFiles = async (params) => {
      fields.dirty = true;
      await syncArchiveFiles(params);
    };

    await nextManager.sync({ reason: "test", force: true });

    expect(nextManager.status().dirty).toBe(true);
    expect(nextManager.status().custom?.indexIdentity).toEqual({ status: "valid" });
  });

  it("closes embedding providers when memory index managers close", async () => {
    const manager = await getFreshManager(createCfg({}));
    await manager.probeEmbeddingAvailability();
    expect(providerFixture.providerCloseCalls).toBe(0);
    await manager.close();
    await manager.close();
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("waits for sync that attaches after provider initialization before closing providers", async () => {
    const providerInit = createDeferred<void>();
    providerFixture.providerInitGate = providerInit.promise;
    const manager = await getFreshManager(createCfg({}));
    const releaseSync = createDeferred<void>();
    const syncStarted = createDeferred<void>();
    const owner = manager as unknown as {
      runSync: (params?: MemorySyncParams) => Promise<void>;
    };
    const originalRunSync = owner.runSync.bind(manager);
    owner.runSync = async (params) => {
      syncStarted.resolve();
      await releaseSync.promise;
      await originalRunSync(params);
    };

    const syncPromise = manager.sync({ reason: "test" });
    await vi.waitFor(() => {
      expect(providerFixture.providerCalls).toHaveLength(1);
    });

    const closePromise = manager.close();
    try {
      providerInit.resolve();
      await syncStarted.promise;
      await Promise.resolve();

      expect(providerFixture.providerCloseCalls).toBe(0);
    } finally {
      releaseSync.resolve();
    }
    await syncPromise;
    await closePromise;
    expect(providerFixture.providerCloseCalls).toBe(1);
  });

  it("indexes multimodal files only from extra paths", async () => {
    const mediaDir = path.join(fixture.paths.workspace, "media-memory");
    await fs.mkdir(mediaDir, { recursive: true });
    await fs.writeFile(path.join(mediaDir, "diagram.png"), Buffer.from("png"));
    await fs.writeFile(path.join(mediaDir, "meeting.wav"), Buffer.from("wav"));
    await fs.writeFile(path.join(mediaDir, "oversized.png"), Buffer.alloc(32, 1));
    await fs.writeFile(path.join(fixture.paths.memory, "default-diagram.png"), Buffer.from("png"));

    const cfg = createCfg({
      provider: "gemini",
      model: "gemini-embedding-2-preview",
      extraPaths: [mediaDir],
      multimodal: { enabled: true, modalities: ["image", "audio"], maxFileBytes: 16 },
    });
    const manager = await getPersistentManager(cfg);
    await manager.sync({ reason: "test" });

    expect(providerFixture.embedBatchInputCalls).toBeGreaterThan(0);
    expect(
      providerFixture.embeddedBatchInputs
        .flat()
        .flatMap((input) =>
          typeof input === "string"
            ? []
            : (input.parts ?? []).flatMap((part) =>
                part.type === "inline-data" ? [`${part.mimeType}:${part.data}`] : [],
              ),
        ),
    ).toEqual(expect.arrayContaining(["image/png:cG5n", "audio/wav:d2F2"]));

    const db = Reflect.get(manager, "db") as DatabaseSync;
    const indexedMediaPaths = () =>
      (
        db
          .prepare(
            "SELECT path FROM memory_index_chunks WHERE source = 'memory' AND path LIKE '%.png' ORDER BY path",
          )
          .all() as Array<{ path: string }>
      ).map((row) => row.path);
    expect(indexedMediaPaths()).toEqual(["media-memory/diagram.png"]);

    const imageResults = await manager.search("image");
    expect(imageResults.some((result) => result.path.endsWith("diagram.png"))).toBe(true);

    const audioResults = await manager.search("audio");
    expect(audioResults.some((result) => result.path.endsWith("meeting.wav"))).toBe(true);

    await manager.close?.();
    const statusManager = await getFreshManager(cfg, "status", true);
    const status = statusManager.status();
    expect(status.sourceCounts?.find((entry) => entry.source === "memory")?.eligible).toBe(
      status.files,
    );
  });

  it("refreshes diagnostic byte totals after indexing without changing the serving manager", async () => {
    const cfg = createCfg({ provider: "none" });
    const serving = await getPersistentManager(cfg);
    await serving.sync({ reason: "test", force: true });
    const diagnostic = await getFreshManager(cfg, "cli", true);
    try {
      expect(diagnostic).not.toBe(serving);
      const previousBytes = diagnostic.status().sourceCounts?.[0]?.chunkBytes;
      expect(previousBytes).toBeGreaterThan(0);
      await writeMemory(
        "2026-01-12.md",
        "# Reindexed diagnostic\n\nFresh expedition notes 🦞 with a different stored payload size.\n",
      );

      await diagnostic.sync({ reason: "cli", force: true });

      const db = Reflect.get(diagnostic, "db") as DatabaseSync;
      db.prepare(`INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
        VALUES ('previous-provider', 'previous-model', 'previous-key', 'retained', ?, 2, 1)`).run(
        encodeMemoryEmbedding([0, 1]),
      );
      expect(diagnostic.status().storage).toMatchObject({
        embeddingCacheEntries: 1,
        embeddingCacheBytes: 16,
      });
      const storedBytes = db
        .prepare(
          "SELECT SUM(length(CAST(text AS BLOB)) + length(CAST(embedding AS BLOB))) AS bytes FROM memory_index_chunks WHERE source = 'memory'",
        )
        .get()?.bytes;
      const refreshedBytes = diagnostic.status().sourceCounts?.[0]?.chunkBytes;
      expect(refreshedBytes).toBe(storedBytes);
      expect(refreshedBytes).not.toBe(previousBytes);
    } finally {
      await diagnostic.close();
    }
    expect((await getMemorySearchManager({ cfg, agentId: "main" })).manager).toBe(serving);
    expect(serving.status().sourceCounts?.[0]?.chunkBytes).toBeUndefined();
    expect(serving.status().storage).toBeUndefined();
  });

  it("rebuilds vector tables created before completeness markers", async () => {
    const cfg = createCfg({ provider: "gemini", vectorEnabled: true });
    const legacyManager = await getFreshManager(cfg);
    const available = await legacyManager.probeVectorStoreAvailability?.();
    if (!available) {
      await legacyManager.close?.();
      return;
    }
    const legacyDb = Reflect.get(legacyManager, "db") as DatabaseSync;
    legacyDb.exec(`
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY,
        embedding FLOAT[3]
      );
      INSERT INTO memory_index_chunks_vec VALUES ('orphan-before-marker', '[1,0,0]');
    `);
    await legacyManager.close?.();

    const manager = await getFreshManager(cfg);
    await expect(manager.probeVectorStoreAvailability?.()).resolves.toBe(false);
    expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
  });

  it("prepares the native vector connection after child retrieval and retires the legacy table", async () => {
    const manager = await getPersistentManager(createCfg({ vectorEnabled: true }));
    await manager.sync({ reason: "test", force: true });
    await expect(manager.search("alpha")).resolves.not.toHaveLength(0);
    expect(manager.status().vector?.storeAvailable).toBe(true);
    const db = Reflect.get(manager, "db") as DatabaseSync;
    db.exec("CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)");

    await expect(manager.probeVectorStoreAvailability?.()).resolves.toBe(true);

    expect(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'")
        .get(),
    ).toBeUndefined();
    expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
  });

  it("reports persisted vector index state on the unprobed status path", async () => {
    const cfg = createCfg({ provider: "gemini", vectorEnabled: true });
    const emptyManager = await getFreshManager(cfg, "status");
    try {
      const emptyStatus = emptyManager.status();
      expect(emptyStatus.chunks).toBe(0);
      expect(emptyStatus.vector?.storeAvailable).toBeUndefined();
      expect(emptyStatus.vector?.index).toEqual({ state: "empty" });
    } finally {
      await emptyManager.close?.();
    }

    const indexingManager = await getFreshManager(cfg);
    try {
      await indexingManager.sync({ reason: "test", force: true });
      expect(indexingManager.status().chunks).toBeGreaterThan(0);
    } finally {
      await indexingManager.close?.();
    }

    const statusManager = await getFreshManager(cfg, "status");
    expect(Reflect.get(statusManager, "vector")).toMatchObject({ available: null, dims: 4 });
    expect(statusManager.status().vector).toMatchObject({
      index: { state: "complete" },
      storeAvailable: undefined,
    });

    const writer = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }));
    try {
      writer
        .prepare("UPDATE memory_index_meta SET value = '1' WHERE key = ?")
        .run("memory_vector_rebuild_v1");
    } finally {
      writer.close();
    }
    expect(statusManager.status().vector?.index).toEqual({ state: "incomplete" });
  });

  it("forces a rebuild after incremental writes while vectors are disabled", async () => {
    const enabledCfg = createCfg({ provider: "gemini", vectorEnabled: true });
    const initialManager = await getFreshManager(enabledCfg);
    await initialManager.sync({ reason: "test", force: true });
    await initialManager.close?.();

    await writeMemory(
      "2026-01-12.md",
      "# Updated\n\nvector writes were disabled for this update\n",
    );
    const disabledManager = await getFreshManager(
      createCfg({ provider: "gemini", vectorEnabled: false }),
    );
    Reflect.set(disabledManager, "dirty", true);
    await disabledManager.sync({ reason: "test" });
    const disabledDb = Reflect.get(disabledManager, "db") as DatabaseSync;
    expect(
      disabledDb
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
        .get(),
    ).toEqual({ value: "1" });
    await disabledManager.close?.();

    const reloadedManager = await getFreshManager(enabledCfg);
    await expect(reloadedManager.probeVectorStoreAvailability?.()).resolves.toBe(false);
    expect(Reflect.get(reloadedManager, "memoryFullRetryDirty")).toBe(true);
    expect(reloadedManager.status().dirty).toBe(true);

    await reloadedManager.sync({ reason: "test" });
    const rebuiltDb = Reflect.get(reloadedManager, "db") as DatabaseSync;
    expect(
      rebuiltDb
        .prepare("SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'")
        .get(),
    ).toEqual({ value: "clean" });
    await expect(reloadedManager.probeVectorStoreAvailability?.()).resolves.toBe(true);
  });

  it("preserves trusted per-line provenance through session indexing", async () => {
    const manager = await getFtsSessionManager();
    if (!manager) {
      return;
    }

    await seedMemoryIndexSessionTranscript({
      sessionId: "session-provenance",
      messages: [
        {
          role: "user",
          senderIsOwner: true,
          timestamp: "2026-07-01T10:00:00.000Z",
          content: "The owner prefers green tea.",
        },
      ],
    });

    await manager.sync({ reason: "test", force: true });
    const results = await manager.search("owner prefers green tea", {
      minScore: 0,
      maxResults: 3,
    });

    expect(results[0]?.source).toBe("sessions");
    expect(results[0]?.provenance).toEqual({
      originClass: "owner",
      sessionKind: "interactive",
      observedAt: Date.parse("2026-07-01T10:00:00.000Z"),
    });
  });

  it("prunes removed sessions without re-embedding unchanged survivors", async () => {
    const cfg = createCfg({
      provider: "gemini",
      sources: ["sessions"],
      sessionMemory: true,
      minScore: 0,
    });
    const sessionId = "status-stale-session-test";
    const sessionKey = `agent:main:memory:${sessionId}`;
    const survivorId = "status-stale-session-survivor";
    const survivorKey = `agent:main:memory:${survivorId}`;
    const storePath = path.join(resolveSessionTranscriptsDirForAgent("main"), "sessions.json");
    await seedSession(sessionId, "Deleted session index canary ORBIT-DELETE-91.", {
      sessionKey,
      role: "user",
      timestamp: 1,
    });
    await seedSession(survivorId, "Surviving session index canary ORBIT-SURVIVE-92.", {
      role: "user",
      timestamp: 2,
      sessionKey: survivorKey,
    });

    const initial = await getFreshManager(cfg, "cli");
    await initial.sync({ reason: "cli", force: true });
    await expect(
      initial.search("ORBIT-DELETE-91", { minScore: 0, sources: ["sessions"] }),
    ).resolves.not.toEqual([]);
    await initial.close?.();
    const agentDb = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }));
    agentDb.exec("DELETE FROM memory_embedding_cache");
    agentDb.close();
    providerFixture.embedBatchCalls = 0;

    await expect(
      deleteSessionEntry({
        agentId: "main",
        archiveTranscript: false,
        expectedSessionId: sessionId,
        sessionKey,
        storePath,
      }),
    ).resolves.toBe(true);

    const statusManager = await getFreshManager(cfg, "status", true);
    expect(statusManager.status().dirty).toBe(true);
    await statusManager.close?.();

    const repairManager = await getFreshManager(cfg, "cli");
    await repairManager.sync({ reason: "cli" });
    expect(providerFixture.embedBatchCalls).toBe(0);
    const deletedResults = await repairManager.search("ORBIT-DELETE-91", {
      minScore: 0,
      sources: ["sessions"],
    });
    expect(deletedResults.some((result) => result.path.includes(sessionId))).toBe(false);
    await expect(
      repairManager.search("ORBIT-SURVIVE-92", { minScore: 0, sources: ["sessions"] }),
    ).resolves.not.toEqual([]);
    const db = Reflect.get(repairManager, "db") as DatabaseSync;
    const sourceCount = db
      .prepare("SELECT COUNT(*) AS count FROM memory_index_sources WHERE source = 'sessions'")
      .get() as { count: number };
    expect(sourceCount.count).toBe(1);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
