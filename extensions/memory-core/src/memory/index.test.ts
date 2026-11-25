import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  encodeMemoryEmbedding,
  loadSqliteVecExtension,
  MEMORY_INDEX_CHUNK_PROVENANCE_TABLE,
  type MemorySyncParams,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import { deleteSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import {
  resolveOpenClawAgentSqlitePath,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  useSqliteWorkerFault,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { writeMemoryIndexArchiveTranscript } from "./index-archive.test-support.js";
import {
  countMemoryIndexFtsMatches,
  createManagerIndexFixture,
  memoryIndexFixtureWriter,
} from "./manager-index.test-support.js";
import type { MemoryTargetedSessionSyncQueue } from "./manager-sync-control.js";
import type { MemoryIndexManager } from "./manager.js";

const fault = useSqliteWorkerFault([
  {
    name: "fail_queued_session_publication",
    match: /^insert into memory_index_chunks\b/u,
    sql: `CREATE TEMP TRIGGER fail_queued_session_publication AFTER INSERT ON main.memory_index_chunks
      BEGIN SELECT RAISE(FAIL, 'forced queued session publication failure'); END;`,
  },
]);

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

function sessionTarget(sessionId: string, sessionKey: string) {
  return { agentId: "main", sessionId, sessionKey };
}

type SyncOwner = {
  sessionSyncQueue: MemoryTargetedSessionSyncQueue;
  syncing: Promise<void> | null;
  closing: boolean;
  closed: boolean;
  syncAdmitted: (params?: MemorySyncParams) => Promise<void>;
  runSync: (params?: MemorySyncParams) => Promise<void>;
};

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

    const manager = await getManager();
    try {
      await manager.sync({ reason: "test", force: true });
      expect(manager.status().dbPath).toBe(agentDbPath);
    } finally {
      await manager.close();
    }

    const reopened = openOpenClawAgentDatabase({ agentId: "main" });
    expect(
      reopened.db
        .prepare("SELECT value_json FROM cache_entries WHERE scope = ? AND key = ?")
        .get("test", "keep-me"),
    ).toEqual({ value_json: JSON.stringify({ value: "keep-me" }) });
  });

  const writeMemory = (filename: string, content: string) =>
    fs.writeFile(path.join(fixture.paths.memory, filename), content);
  const writeWorkspace = (filename: string, content: string) =>
    fs.writeFile(path.join(fixture.paths.workspace, filename), content);
  const getManager = (
    options: Parameters<typeof createCfg>[0] = {},
    purpose?: Parameters<typeof getFreshManager>[1],
  ) => getFreshManager(createCfg(options), purpose);
  const getSessionManager = (purpose?: Parameters<typeof getFreshManager>[1]) =>
    getManager({ provider: "none", sources: ["sessions"], sessionMemory: true }, purpose);
  const getBatchManager = () => getManager({ provider: "batch-wide-test", batchEnabled: true });
  const read = (manager: MemoryIndexManager, sql: string) =>
    (Reflect.get(manager, "db") as DatabaseSync).prepare(sql);
  const rebuildMarker = (manager: MemoryIndexManager) =>
    read(
      manager,
      "SELECT value FROM memory_index_meta WHERE key = 'memory_vector_rebuild_v1'",
    ).get();
  function expectStatusIdentity(manager: MemoryIndexManager, dirty: boolean, identity: unknown) {
    const status = manager.status();
    expect(status.dirty).toBe(dirty);
    expect(status.custom?.indexIdentity).toEqual(identity);
  }

  async function indexAndClose(manager: MemoryIndexManager) {
    await manager.sync({ reason: "test", force: true });
    await manager.close();
  }

  async function queueFixture(namespace: string, purpose?: Parameters<typeof getFreshManager>[1]) {
    const manager = await getSessionManager(purpose);
    const owner = manager as unknown as SyncOwner;
    const sessionKey = (id: string) => `${namespace}:${id}`;
    const target = (id: string) => sessionTarget(id, sessionKey(id));
    const syncTarget = (id: string, params: Omit<MemorySyncParams, "sessions">) =>
      manager.sync({ ...params, sessions: [target(id)] });
    return { manager, owner, sessionKey, syncTarget };
  }

  async function seedSession(
    sessionId: string,
    content: string,
    options: {
      role?: "user" | "assistant";
      timestamp: number | string;
      sessionKey?: string;
      senderIsOwner?: boolean;
    },
  ) {
    const { sessionKey, role = "user", ...message } = options;
    await seedMemoryIndexSessionTranscript({
      sessionId,
      sessionKey,
      messages: [{ ...message, role, content }],
    });
  }

  async function seedTargets(markers: Record<string, string>, sessionKey: (id: string) => string) {
    for (const [id, marker] of Object.entries(markers)) {
      await seedSession(id, marker, { timestamp: Date.now(), sessionKey: sessionKey(id) });
    }
  }

  async function getReconfiguredSessionManager(sources: Array<"memory" | "sessions">) {
    const config = { sources, sessionMemory: true, model: "old-embed" };
    await indexAndClose(await getManager(config));
    return getManager({ ...config, provider: "gemini", model: "new-embed" });
  }

  it("rebuilds a missing vector table through forced sync with cached readiness", async () => {
    const manager = await getManager({ vectorEnabled: true });
    await manager.sync({ reason: "test", force: true });
    const db = memoryIndexFixtureWriter(manager);
    expect((await loadSqliteVecExtension({ db })).ok).toBe(true);
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
    expect(await manager.search("alpha")).toContainEqual(
      expect.objectContaining({ path: "memory/2026-01-12.md" }),
    );
  });

  it("round-trips mixed-case project keys through indexed recall consumers", async () => {
    const projectKey = "github.com/OpenClaw/OpenClaw";
    await writeWorkspace(
      "MEMORY.md",
      `- Follow the kraken deploy ritual. <!-- trigger: kraken deploy ritual --> <!-- importance: 8 --> <!-- project: ${projectKey} -->\n`,
    );

    const manager = await getManager();
    await manager.sync({ reason: "test", force: true });
    const activeProjectKeys = [projectKey];
    const curated = await manager.listCuratedProjectCandidates({ activeProjectKeys });
    const triggers = await manager.listTriggerCandidates({ activeProjectKeys });
    const expectedCandidates = [
      { projectKey, triggers: "kraken deploy ritual", provenance: { originClass: "agent" } },
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
    await writeWorkspace(
      "MEMORY.md",
      `- Quarantined release instruction. <!-- trigger: release instruction --> <!-- project: ${projectKey} -->\n`,
    );
    const manager = await getManager({ provider: "none" });
    await manager.sync({ reason: "test", force: true });
    memoryIndexFixtureWriter(manager)
      .prepare(
        `UPDATE ${MEMORY_INDEX_CHUNK_PROVENANCE_TABLE}
       SET origin_class = 'untrusted'
       WHERE chunk_id IN (
         SELECT id FROM memory_index_chunks WHERE path = 'MEMORY.md' AND source = 'memory'
       )`,
      )
      .run();
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
    expect(explicit).toContainEqual(
      expect.objectContaining({
        provenance: expect.objectContaining({ originClass: "untrusted" }),
      }),
    );
  });

  it("keeps invalid project annotations scoped but unsatisfiable", async () => {
    await writeWorkspace(
      "MEMORY.md",
      [
        "- Invalid fact. <!-- trigger: invalid fact --> <!-- project: bad< -->",
        "- Mixed fact. <!-- trigger: mixed fact --> <!-- project: alpha-key; bad< -->",
        "- Unterminated fact. <!-- trigger: unterminated fact --> <!-- project: alpha-key",
        "- Global fact. <!-- trigger: global fact -->",
      ].join("\n"),
    );
    const manager = await getManager({ provider: "none" });
    await manager.sync({ reason: "test", force: true });
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
    const manager = await getManager();
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

  it.each(["failure", "decline"])(
    "maps source-wide batch %s fallback results to missing chunks after cache hits",
    async (completion) => {
      const manager = await getBatchManager();
      await manager.sync({ reason: "test" });

      await writeMemory("2026-01-13.md", "# Log\nBeta memory line.");
      providerFixture.providerRuntimeBatchCalls = [];
      providerFixture.providerRuntimeBatchFailuresRemaining = completion === "failure" ? 1 : 0;
      providerFixture.providerRuntimeBatchDeclines = completion === "decline";
      providerFixture.embedBatchCalls = 0;

      await manager.sync({ reason: "test", force: true });

      expect(providerFixture.providerRuntimeBatchCalls).toHaveLength(1);
      expect(providerFixture.embedBatchCalls).toBe(1);
      const betaRow = read(
        manager,
        "SELECT embedding FROM memory_index_chunks WHERE path LIKE ? AND source = ?",
      ).get("%2026-01-13.md", "memory") as { embedding: Uint8Array } | undefined;

      expect(betaRow).toBeDefined();
      expect(betaRow?.embedding).toEqual(encodeMemoryEmbedding([0, 1, 0, 0]));
    },
  );

  it("counts local batch attempts and bypasses batching after repeated failures", async () => {
    providerFixture.providerRuntimeBatchErrors = [
      Object.assign(new Error("provider runtime batch failed"), {
        batchAttempts: Number.MAX_SAFE_INTEGER,
      }),
    ];
    const manager = await getBatchManager();
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

  it.each([
    {
      name: "disables batch immediately when the provider reports it unavailable",
      errors: [
        Object.assign(new Error("provider batch unavailable"), {
          code: "embedding_batch_unavailable",
        }),
      ],
      attempts: 1,
      lastError: "provider batch unavailable",
    },
    {
      name: "preserves frozen errors while recording both attempts",
      errors: [
        new Error("memory embeddings batch timed out"),
        Object.freeze(new Error("provider runtime retry failed")),
      ],
      attempts: 2,
      lastError: "provider runtime retry failed",
    },
  ])("$name", async ({ errors, attempts, lastError }) => {
    providerFixture.providerRuntimeBatchErrors = errors;
    const manager = await getBatchManager();
    await manager.sync({ reason: "test" });

    expect(providerFixture.providerRuntimeBatchCalls).toHaveLength(attempts);
    expect(providerFixture.embedBatchCalls).toBe(1);
    expect(manager.status().batch).toMatchObject({ enabled: false, failures: 2, lastError });
  });

  it("resets batch failures when a timeout retry recovers", async () => {
    providerFixture.providerRuntimeBatchErrors = [new Error("provider runtime batch failed")];
    const manager = await getBatchManager();
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
      const manager = await getManager({ provider: "batch-test", batchEnabled: true });
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
      timestamp: "2026-04-07T15:25:04.113Z",
    });
    await seedSession("session-beta", "Session beta memory line.", {
      role: "assistant",
      timestamp: "2026-04-07T15:25:04.113Z",
    });
    const manager = await getManager({
      provider: "batch-wide-test",
      batchEnabled: true,
      sources: ["memory", "sessions"],
      sessionMemory: true,
    });
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
    await indexAndClose(await getManager({ provider: "gemini", model: "gemini-embed" }));

    const statusManager = await getManager({ provider: "gemini", model: "" }, "status");
    expectStatusIdentity(statusManager, false, { status: "valid" });
  });

  it("rebuilds missing metadata with existing chunks before search", async () => {
    const cfg = createCfg({});
    await writeWorkspace("USER.md", "Beta memory line.");
    await indexAndClose(await getFreshManager(cfg));
    await fs.rm(path.join(fixture.paths.memory, "2026-01-12.md"));

    await withOpenClawAgentDatabaseWrite({ agentId: "main" }, ({ db }) =>
      db.exec(`DELETE FROM memory_index_meta WHERE key = 'memory_index_meta_v1'`),
    );
    const nextManager = await getFreshManager(cfg);
    expect(nextManager.status().custom?.indexIdentity).toMatchObject({ status: "missing" });

    const results = await nextManager.search("alpha");

    expectStatusIdentity(nextManager, false, { status: "valid" });
    expect(results.some((result) => result.path.endsWith("memory/2026-01-12.md"))).toBe(false);
    expect(results.some((result) => result.path === "USER.md")).toBe(true);
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
    const { manager, sessionKey, syncTarget } = await queueFixture("agent:main:proof", "cli");
    const dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    try {
      await manager.sync({ reason: "test-baseline", force: true });
      await seedTargets(markers, sessionKey);

      fault.enable();

      const active = syncTarget("blocker", { reason: "test-failed-owner" });
      const failedQueued = syncTarget("retained", { reason: "test-queued-retained" });
      const failures = await Promise.allSettled([active, failedQueued]);
      for (const result of failures) {
        assert.ok(result.status === "rejected", "expected failed SQLite publication to reject");
        expect(result.reason).toMatchObject({
          message: "forced queued session publication failure",
        });
      }
      fault.disable();

      expect(countMemoryIndexFtsMatches(dbPath, markers.retained)).toBe(0);
      expect(countMemoryIndexFtsMatches(dbPath, markers.trigger)).toBe(0);
      // Hand ordinary dirty state to maintenance so recovery must use the retained queue.
      manager.takeReindexRetryStateForMaintenance();

      const recoveryProgress = vi.fn();
      const recovery = syncTarget("trigger", {
        reason: "test-recovery-trigger",
        progress: recoveryProgress,
      });
      // A full sync can claim `syncing` before the retained queue owner resumes.
      // Both owners must settle without the queue awaiting its own promise.
      const competingFullSync = manager.sync({ reason: "test-competing-full-sync" });
      const recoveryResults = await Promise.allSettled([recovery, competingFullSync]);
      expect(recoveryResults.map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);

      expect(countMemoryIndexFtsMatches(dbPath, markers.retained)).toBeGreaterThan(0);
      expect(countMemoryIndexFtsMatches(dbPath, markers.trigger)).toBeGreaterThan(0);
      expect(recoveryProgress).toHaveBeenCalled();
    } finally {
      fault.disable();
      await manager.close?.();
    }
  });

  it("drains retained queued targets from a live rejection transition", async () => {
    const markers = {
      retained: "LIVE REJECTION RETAINED TARGET 729",
      transition: "LIVE REJECTION TRANSITION TARGET 729",
      trigger: "LIVE REJECTION RECOVERY TARGET 729",
    };
    // Startup catchup must not consume the controlled sync mocks.
    const { manager, owner, sessionKey, syncTarget } = await queueFixture(
      "agent:main:live-rejection",
      "cli",
    );
    const activeSyncGate = createDeferred<void>();
    const queuedSyncGate = createDeferred<void>();
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
      await seedTargets(markers, sessionKey);

      const active = syncTarget("active", { reason: "test-live-rejection-owner" });
      const queuedProgress = vi.fn();
      const failedQueued = syncTarget("retained", {
        reason: "test-live-rejection-queued",
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
      assert.ok(rejectingQueuedSync, "expected a live queued sync");

      const transitionResult = createDeferred<PromiseSettledResult<void>>();
      const transitionProgress = vi.fn();
      void rejectingQueuedSync.catch(() => {
        const transitionCall = syncTarget("transition", {
          reason: "test-live-rejection-transition",
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
      for (const failure of [failures[1], transitionFailure]) {
        expect(failure?.status).toBe("rejected");
        assert.ok(failure?.status === "rejected", "expected shared queued rejection");
        expect(failure.reason).toBe(queuedError);
      }
      expect(queuedProgress).not.toHaveBeenCalled();
      expect(transitionProgress).not.toHaveBeenCalled();

      const recoveryProgress = vi.fn();
      await syncTarget("trigger", {
        reason: "test-live-rejection-recovery",
        progress: recoveryProgress,
      });

      const dbPath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      const observer = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const count = observer.prepare(
          "SELECT COUNT(*) AS count FROM memory_index_chunks WHERE text LIKE ?",
        );
        for (const marker of Object.values(markers)) {
          expect(count.get(`%${marker}%`)?.count).toBeGreaterThan(0);
        }
      } finally {
        observer.close();
      }
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
    const { manager, owner, syncTarget } = await queueFixture("agent:main");
    const fullSyncGate = createDeferred<void>();
    const syncAdmitted = vi.spyOn(owner, "syncAdmitted");
    const runSyncSpy = vi.spyOn(owner, "runSync").mockReturnValueOnce(fullSyncGate.promise);
    const progress = vi.fn();
    owner.sessionSyncQueue.sessions.set(
      "retained",
      sessionTarget("retained-close", "agent:main:retained-close"),
    );

    try {
      const recovery = syncTarget("trigger-close", {
        reason: "test-close-recovery",
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
    expectStatusIdentity(nextManager, true, {
      status: "mismatched",
      reason: "index was built for model old-embed, expected new-embed",
      code: "model",
      owner: "configuration",
    });
    await expect(nextManager.search("alpha")).resolves.toStrictEqual([]);
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

    expectStatusIdentity(nextManager, true, { status: "valid" });
  });

  it("waits for sync that attaches after provider initialization before closing providers", async () => {
    const providerInit = createDeferred<void>();
    providerFixture.providerInitGate = providerInit.promise;
    const manager = await getManager();
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
    await manager.close();
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
    const mediaInputs = providerFixture.embeddedBatchInputs
      .flat()
      .flatMap((input) => (typeof input === "string" ? [] : (input.parts ?? [])))
      .flatMap((part) => (part.type === "inline-data" ? [`${part.mimeType}:${part.data}`] : []));
    expect(mediaInputs).toEqual(expect.arrayContaining(["image/png:cG5n", "audio/wav:d2F2"]));
    expect(
      read(
        manager,
        "SELECT path FROM memory_index_chunks WHERE source = 'memory' AND path LIKE '%.png' ORDER BY path",
      ).all(),
    ).toEqual([{ path: "media-memory/diagram.png" }]);

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
      memoryIndexFixtureWriter(diagnostic)
        .prepare(`INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
        VALUES ('previous-provider', 'previous-model', 'previous-key', 'retained', ?, 2, 1)`)
        .run(encodeMemoryEmbedding([0, 1]));
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
    expect(
      (
        await getMemorySearchManager({
          runInBackgroundContext: runInMemoryTestBackgroundContext,
          cfg,
          agentId: "main",
        })
      ).manager,
    ).toBe(serving);
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
    const legacyDb = memoryIndexFixtureWriter(legacyManager);
    expect((await loadSqliteVecExtension({ db: legacyDb })).ok).toBe(true);
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

  it("retires a legacy vector table when reopening an indexed database", async () => {
    const cfg = createCfg({ vectorEnabled: true });
    await indexAndClose(await getPersistentManager(cfg));
    await withOpenClawAgentDatabaseWrite({ agentId: "main" }, ({ db }) =>
      db.exec("CREATE TABLE chunks_vec (id TEXT PRIMARY KEY, embedding BLOB)"),
    );
    const manager = await getPersistentManager(cfg);

    await expect(manager.probeVectorStoreAvailability?.()).resolves.toBe(true);

    expect(
      read(
        manager,
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chunks_vec'",
      ).get(),
    ).toBeUndefined();
    expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(true);
    await expect(manager.search("alpha")).resolves.not.toHaveLength(0);
  });

  it("forces a rebuild after incremental writes while vectors are disabled", async () => {
    const enabledCfg = createCfg({ provider: "gemini", vectorEnabled: true });
    await indexAndClose(await getFreshManager(enabledCfg));
    const complete = await getFreshManager(enabledCfg, "status");
    expect(complete.status().vector).toMatchObject({
      index: { state: "complete" },
      storeAvailable: undefined,
    });
    await complete.close();

    await writeMemory(
      "2026-01-12.md",
      "# Updated\n\nvector writes were disabled for this update\n",
    );
    const disabledManager = await getManager({ provider: "gemini", vectorEnabled: false });
    Reflect.set(disabledManager, "dirty", true);
    await disabledManager.sync({ reason: "test" });
    expect(rebuildMarker(disabledManager)).toEqual({ value: "1" });
    await disabledManager.close?.();
    const incomplete = await getFreshManager(enabledCfg, "status");
    expect(incomplete.status().vector?.index).toEqual({ state: "incomplete" });
    await incomplete.close();

    const reloadedManager = await getFreshManager(enabledCfg);
    await expect(reloadedManager.probeVectorStoreAvailability?.()).resolves.toBe(false);
    expect(Reflect.get(reloadedManager, "memoryFullRetryDirty")).toBe(true);
    expect(reloadedManager.status().dirty).toBe(true);

    await reloadedManager.sync({ reason: "test" });
    expect(rebuildMarker(reloadedManager)).toEqual({ value: "clean" });
    await expect(reloadedManager.probeVectorStoreAvailability?.()).resolves.toBe(true);
  });

  it("preserves trusted per-line provenance through session indexing", async () => {
    const manager = await getFtsSessionManager();
    if (!manager) {
      return;
    }

    await seedSession("session-provenance", "The owner prefers green tea.", {
      senderIsOwner: true,
      timestamp: "2026-07-01T10:00:00.000Z",
    });

    await manager.sync({ reason: "test", force: true });
    const results = await manager.search("owner prefers green tea", { minScore: 0, maxResults: 3 });

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
      timestamp: 1,
    });
    await seedSession(survivorId, "Surviving session index canary ORBIT-SURVIVE-92.", {
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
    const searchSessions = (query: string) =>
      repairManager.search(query, { minScore: 0, sources: ["sessions"] });
    await repairManager.sync({ reason: "cli" });
    expect(providerFixture.embedBatchCalls).toBe(0);
    const deletedResults = await searchSessions("ORBIT-DELETE-91");
    expect(deletedResults.some((result) => result.path.includes(sessionId))).toBe(false);
    await expect(searchSessions("ORBIT-SURVIVE-92")).resolves.not.toEqual([]);
    const sourceCount = read(
      repairManager,
      "SELECT COUNT(*) AS count FROM memory_index_sources WHERE source = 'sessions'",
    ).get() as { count: number };
    expect(sourceCount.count).toBe(1);
  });
});
