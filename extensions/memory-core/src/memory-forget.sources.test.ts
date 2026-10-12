import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as storage from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { deleteSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  openOpenClawAgentDatabase,
  openNodeSqliteDatabase,
  resolveOpenClawAgentSqlitePath,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  listMemoryEntryOrigins,
  pruneMemoryEntryOrigins,
  recordMemoryEntryOrigins,
} from "./memory-entry-origins.js";
import { observeMemoryForgetWorker } from "./memory-forget-fault.test-support.js";
import { readMemoryForgetIndexInWorker } from "./memory-forget-index-read.js";
import { planMemoryIndex } from "./memory-forget-index-sources.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import * as cpuRuntime from "./memory/manager-cpu-worker-runtime.js";
import { readMemoryForgetTombstonesForTest } from "./test-helpers.js";

describe("memory forget source removal", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;

  beforeEach(async () => {
    fixture = await createMemoryForgetFixture();
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  function indexSelection() {
    return {
      changedPaths: new Set<string>(),
      removedPaths: new Set<string>(),
      sessionIds: new Set(["target"]),
      excludedSessionIds: new Set<string>(),
      entryKeys: new Set<string>(),
      corpusSnippets: new Set<string>(),
    };
  }

  it("skips unselectable sources while preserving explicit file removals", async () => {
    const { db, path: databasePath } = openOpenClawAgentDatabase({ agentId: "main" });
    db.prepare(`INSERT INTO memory_index_sources (path, source, hash, mtime, size)
      VALUES ('memory/retained.md', 'memory', 'retained', 1, 1)`).run();
    const request = {
      kind: "forget-index-plan" as const,
      agentId: "main",
      databasePath,
      stateDir: fixture.stateDir,
      changedPaths: ["MEMORY.md"],
      removedPaths: [],
      sessionIds: ["target"],
      excludedSessionIds: [],
      entryKeys: [],
      corpusSnippets: [],
    };
    const observer = observeHostDataSql();
    try {
      expect(await readMemoryForgetIndexInWorker(request)).toMatchObject({
        chunks: [],
        sources: [],
      });
      expect(
        observer.queries.filter((sql) => /\bfrom\s+"?memory_index_sources\b/iu.test(sql)),
      ).toEqual([]);
      expect(
        await readMemoryForgetIndexInWorker({ ...request, removedPaths: ["memory/retained.md"] }),
      ).toMatchObject({ sources: [{ path: "memory/retained.md", source: "memory" }] });
    } finally {
      observer.restore();
    }
  });

  it("retains planning input and placement across dispatch without creating missing stores", async () => {
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: fixture.stateDir } };
    const db = openOpenClawAgentDatabase(options).db;
    db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('selected', 'memory/selected.md', 'memory', 1, 1, 'hash', 'test', ?, x'', 1)`).run(
      "A retained indexed amber detail.",
    );
    const selection = indexSelection();
    selection.corpusSnippets.add("indexed amber detail");
    const run = cpuRuntime.runMemoryForgetIndexPlan;
    const release = createDeferred<void>();
    const transport = vi
      .spyOn(cpuRuntime, "runMemoryForgetIndexPlan")
      .mockImplementationOnce(async (request) => {
        await release.promise;
        return run(request);
      });
    const reading = planMemoryIndex(selection, options);
    const alternate = path.join(fixture.stateDir, "uncreated-alternate");
    try {
      selection.corpusSnippets.clear();
      options.env.OPENCLAW_STATE_DIR = alternate;
      vi.stubEnv("OPENCLAW_STATE_DIR", alternate);
      release.resolve();
      const plan = await reading;
      expect(plan.chunks).toEqual([
        { id: "selected", path: "memory/selected.md", source: "memory" },
      ]);
      expect(plan.embeddingCacheRows).toBe(0);
      expect(await planMemoryIndex(indexSelection(), options)).toEqual({
        chunks: [],
        sources: [],
        ftsRows: 0,
        vectorRows: 0,
        embeddingCacheRows: 0,
        hasVectorTable: false,
      });
      await expect(fs.access(alternate)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      release.resolve();
      await reading.catch(() => undefined);
      transport.mockRestore();
      vi.stubEnv("OPENCLAW_STATE_DIR", fixture.stateDir);
    }
  });

  it.each([
    [
      "missing required table",
      /Session metadata unavailable \(table-missing: memory_index_chunks\)/,
    ],
    ["newer schema", /uses newer schema version 999/],
    ["unreadable source", /file is not a database/],
  ] as const)(
    "refuses %s during source validation without repairing its source",
    async (failure, message) => {
      openOpenClawAgentDatabase({ agentId: "main" });
      const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
      await closeOpenClawAgentDatabasesAsync(fixture.stateDir);
      closeOpenClawAgentDatabasesForTest(fixture.stateDir);
      const original = await fs.readFile(databasePath);
      try {
        if (failure === "unreadable source") {
          await fs.writeFile(databasePath, "not a SQLite database");
        } else {
          const setup = openNodeSqliteDatabase(databasePath);
          try {
            setup.exec(
              failure === "newer schema"
                ? "PRAGMA user_version = 999"
                : "DROP TABLE memory_index_chunks",
            );
          } finally {
            setup.close();
          }
        }
        const beforeRead = await fs.readFile(databasePath);
        const reading = async () =>
          failure === "missing required table"
            ? pruneMemoryEntryOrigins({
                workspaceDir: fixture.workspaceDir,
                agentIds: ["main"],
                entryKeys: ["candidate"],
                retainedEntryKeys: new Set(),
              })
            : listMemoryEntryOrigins({ agentId: "main" });
        await expect(reading()).rejects.toThrow(
          failure === "missing required table"
            ? /missing table memory_index_chunks; run openclaw doctor --fix to repair it/
            : message,
        );
        await expect(
          planMemoryIndex(indexSelection(), {
            agentId: "main",
            path: databasePath,
            env: { OPENCLAW_STATE_DIR: fixture.stateDir },
          }),
        ).rejects.toThrow(message);
        expect(await fs.readFile(databasePath)).toEqual(beforeRead);
      } finally {
        await closeOpenClawAgentDatabasesAsync(fixture.stateDir);
        closeOpenClawAgentDatabasesForTest(fixture.stateDir);
        await fs.writeFile(databasePath, original);
      }
    },
  );

  it.each(["removed", "new mixed contributor"] as const)(
    "keeps selected file provenance when another workspace leaves lineage %s during planning",
    async (change) => {
      await seedMemoryForgetSession("target");
      await seedMemoryForgetSession("survivor");
      const selected = {
        entryKey: "selected-entry",
        agentId: "main",
        sessionId: "target",
        sessionKey: null,
        originClass: "owner" as const,
        observedAt: 1,
      };
      const survivor = { ...selected, entryKey: "survivor-entry", sessionId: "survivor" };
      await recordMemoryEntryOrigins({ agentId: "main", origins: [selected, survivor] });
      const memoryPath = path.join(fixture.workspaceDir, "MEMORY.md");
      const retained =
        "<!-- openclaw-memory-promotion:survivor-entry -->\n- Retained amber detail.\n";
      await fs.writeFile(
        memoryPath,
        "<!-- openclaw-memory-promotion:selected-entry -->\n- Selected violet detail.\n" + retained,
      );
      const otherWorkspace = path.join(fixture.stateDir, "other-workspace");
      await fs.mkdir(otherWorkspace);
      const planning = createDeferred<void>();
      const resume = createDeferred<void>();
      const list = storage.listMemoryFiles;
      const planningSpy = vi
        .spyOn(storage, "listMemoryFiles")
        .mockImplementationOnce(async (...args) => {
          const files = await list(...args);
          planning.resolve();
          await resume.promise;
          return files;
        });
      const forgetting = forgetMemoryEntries({
        cfg: fixture.cfg,
        agentId: "main",
        sessionIds: ["target"],
      });
      void forgetting.catch(() => undefined);
      try {
        await Promise.race([
          planning.promise,
          forgetting.then(() => {
            throw new Error("Forget completed before its actual file-planning boundary");
          }),
        ]);
        await withMemoryWorkspaceLock(otherWorkspace, async () => {
          if (change === "removed") {
            await pruneMemoryEntryOrigins({
              workspaceDir: otherWorkspace,
              agentIds: ["main"],
              entryKeys: [selected.entryKey],
              retainedEntryKeys: new Set(),
            });
            expect(
              await listMemoryEntryOrigins({ agentId: "main", entryKeys: [selected.entryKey] }),
            ).toEqual([]);
          } else {
            await recordMemoryEntryOrigins({
              agentId: "main",
              origins: [{ ...selected, sessionId: "survivor" }],
            });
          }
        });
        resume.resolve();
        const report = await forgetting;
        const durable = {
          entryKeys: report.entryKeys,
          mixedLineageEntryKeys: report.mixedLineageEntryKeys,
          untargetableEntryKeys: report.untargetableEntryKeys,
          memory: await fs.readFile(memoryPath, "utf8"),
          origins: await listMemoryEntryOrigins({ agentId: "main" }),
          tombstones: readMemoryForgetTombstonesForTest({ agentId: "main" }).map(
            ({ sessionId }) => sessionId,
          ),
        };
        expect(durable).toEqual({
          entryKeys: [selected.entryKey],
          mixedLineageEntryKeys: change === "new mixed contributor" ? [selected.entryKey] : [],
          untargetableEntryKeys: [],
          memory: retained,
          origins: [survivor],
          tombstones: ["target"],
        });
      } finally {
        resume.resolve();
        planningSpy.mockRestore();
        await Promise.allSettled([forgetting]);
      }
    },
  );

  it("refuses a retired execution owner without writing to its successor after vector preparation", async () => {
    await seedMemoryForgetSession("target");
    const origin = {
      entryKey: "selected-entry",
      agentId: "main",
      sessionId: "target",
      sessionKey: null,
      originClass: "owner" as const,
      observedAt: 1,
    };
    await recordMemoryEntryOrigins({ agentId: "main", origins: [origin] });
    const memoryPath = path.join(fixture.workspaceDir, "MEMORY.md");
    const content =
      "<!-- openclaw-memory-promotion:selected-entry -->\n- Selected violet detail.\n";
    await fs.writeFile(memoryPath, content);
    const { db } = openOpenClawAgentDatabase({ agentId: "main" });
    const load = storage.loadSqliteVecExtension;
    const loaded = await load({ db });
    expect(loaded.ok).toBe(true);
    db.exec(
      "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2])",
    );
    db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('selected-snapshot', 'MEMORY.md', 'memory', 1, 2, 'fixture', 'test', ?, ?, 1)`).run(
      content,
      storage.encodeMemoryEmbedding([1, 0]),
    );
    db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
      "selected-snapshot",
      new Float32Array([1, 0]),
    );
    const borrowCaptured = createDeferred<void>();
    const resume = createDeferred<void>();
    let intercepted = false;
    const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
    const openSpy = vi
      .spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2")
      .mockImplementation(async (...args) => {
        const [options, , worker] = args;
        if (options.path === db.location() && !intercepted) {
          const input = worker.input;
          if (
            typeof input !== "object" ||
            input === null ||
            !("kind" in input) ||
            input.kind !== "forget" ||
            !("extensionPath" in input) ||
            typeof input.extensionPath !== "string"
          ) {
            throw new Error("Expected Forget's original borrow with prepared vector extension");
          }
          intercepted = true;
          borrowCaptured.resolve();
          await resume.promise;
        }
        return await open(...args);
      });
    const forgetting = forgetMemoryEntries({
      cfg: fixture.cfg,
      agentId: "main",
      sessionIds: ["target"],
    });
    const settled = forgetting.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const readDurable = async (database: DatabaseSync) => ({
      memory: await fs.readFile(memoryPath, "utf8"),
      origins: await listMemoryEntryOrigins({ agentId: "main" }),
      tombstones: readMemoryForgetTombstonesForTest({ agentId: "main" }),
      chunks: database.prepare("SELECT id, text FROM memory_index_chunks ORDER BY id").all(),
      vectors: database.prepare("SELECT id FROM memory_index_chunks_vec ORDER BY id").all(),
      revision: database.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get(),
    });
    try {
      await Promise.race([
        borrowCaptured.promise,
        settled.then(() => {
          throw new Error(
            "Forget settled before its original borrow reached the canonical Worker opener",
          );
        }),
      ]);
      // Explicit canonical disposal revokes even a live borrow; eviction would retain it.
      closeOpenClawAgentDatabasesForTest(fixture.stateDir);
      expect(db.isOpen).toBe(false);
      await closeOpenClawAgentDatabasesAsync(fixture.stateDir);
      const successor = openOpenClawAgentDatabase({ agentId: "main" }).db;
      // Matcher deep-equality diagnostics cannot inspect a closed native handle.
      expect(successor === db).toBe(false);
      const successorLoaded = await load({ db: successor });
      expect(successorLoaded.ok).toBe(true);
      const before = await readDurable(successor);
      resume.resolve();
      const outcome = await settled;
      const after = await readDurable(successor);
      expect.soft(outcome).toMatchObject({
        ok: false,
        error: { message: "Agent database execution admission is closed" },
      });
      expect(after).toEqual(before);
      expect(after.tombstones).toEqual([]);
      expect(after.origins).toEqual([origin]);
      expect(after.memory).toBe(content);
    } finally {
      resume.resolve();
      openSpy.mockRestore();
      await Promise.allSettled([forgetting]);
      await closeOpenClawAgentDatabasesAsync(fixture.stateDir);
    }
  });

  it("forgets 32 sessions with bounded writes and preserves other sources", async () => {
    const sessionCount = 32;
    const { cfg } = fixture;
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const insertSource = db.prepare(
      "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, 1, 1)",
    );
    const insertChunk = db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, ?, 'sessions', 1, 1, 'fixture-hash', 'test', 'forget', x'', 1)`);
    const provenance = db.prepare(`INSERT INTO memory_index_chunk_provenance
      (chunk_id, origin_class, session_kind, observed_at) VALUES (?, 'agent', 'interactive', 1)`);
    const sessionIds = Array.from({ length: sessionCount }, (_, index) => `target-${index}`);
    const paths = Array.from(
      { length: 32 },
      (_, index) =>
        `sessions/main/${sessionIds[index % sessionCount]!}.jsonl.deleted.2026-08-25T10-00-00.${String(index).padStart(3, "0")}Z.zst`,
    );
    for (const [index, sourcePath] of paths.entries()) {
      insertSource.run(sourcePath, "sessions", "remove");
      insertChunk.run(`chunk-${index}`, sourcePath);
      provenance.run(`chunk-${index}`);
    }
    insertSource.run(paths[0]!, "memory", "keep-memory");
    insertSource.run("sessions/main/survivor.jsonl", "sessions", "keep-session");
    const survivors = db
      .prepare("SELECT * FROM memory_index_sources WHERE hash != 'remove' ORDER BY id")
      .all();
    const preview = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds,
      dryRun: true,
    });
    expect(preview.artifacts.indexSources).toBe(32);
    expect(db.prepare("SELECT count(*) AS count FROM memory_index_sources").get()).toEqual({
      count: 34,
    });
    const reportPath = path.join(fixture.stateDir, "forget-native-counts.jsonl");
    const restore = observeMemoryForgetWorker(db, { reportPath });
    try {
      const result = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds });
      expect(result).toEqual({ ...preview, dryRun: false });
      expect(db.prepare("SELECT * FROM memory_index_sources ORDER BY id").all()).toEqual(survivors);
      expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual([]);
      expect(readMemoryForgetTombstonesForTest({ agentId: "main" })).toMatchObject(
        sessionIds.toSorted().map((sessionId) => ({ sessionId, reason: "forgotten" })),
      );
      let sourceDeletes = 0;
      let tombstoneInserts = 0;
      const reports = (await fs.readFile(reportPath, "utf8")).trim().split("\n");
      for (const report of reports) {
        const counts: unknown = JSON.parse(report);
        if (
          typeof counts !== "object" ||
          counts === null ||
          !("sourceDeletes" in counts) ||
          typeof counts.sourceDeletes !== "number" ||
          !("tombstoneInserts" in counts) ||
          typeof counts.tombstoneInserts !== "number"
        ) {
          throw new Error("Invalid native Forget execution counts");
        }
        sourceDeletes += counts.sourceDeletes;
        tombstoneInserts += counts.tombstoneInserts;
      }
      expect(sourceDeletes).toBeGreaterThan(0);
      expect(sourceDeletes).toBeLessThanOrEqual(2);
      expect(tombstoneInserts).toBeGreaterThan(0);
      expect(tombstoneInserts).toBeLessThanOrEqual(2);
    } finally {
      restore();
    }
  });
  it("keeps the index intact when batched admission fails", async () => {
    const { cfg } = fixture;
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const sessionIds = Array.from({ length: 130 }, (_, index) => `target-${index}`);
    db.prepare(`INSERT INTO memory_index_sources (path, source, hash, mtime, size)
      VALUES ('sessions/main/target-0.jsonl', 'sessions', 'keep-until-admitted', 1, 1)`).run();
    db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('target-chunk', 'sessions/main/target-0.jsonl', 'sessions', 1, 1, 'hash', 'test', 'forget', x'', 1)`).run();
    db.prepare(`INSERT INTO memory_index_chunk_provenance
      (chunk_id, origin_class, session_kind, observed_at)
      VALUES ('target-chunk', 'agent', 'interactive', 1)`).run();
    const sources = db.prepare("SELECT * FROM memory_index_sources").all();
    const chunks = db.prepare("SELECT * FROM memory_index_chunks").all();
    const revision = db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get();
    const restore = observeMemoryForgetWorker(db, {
      trigger: {
        event: "BEFORE INSERT ON memory_session_tombstones WHEN NEW.session_id = 'target-129'",
        message: "synthetic admission failure",
        action: "FAIL",
      },
    });
    try {
      await expect(forgetMemoryEntries({ cfg, agentId: "main", sessionIds })).rejects.toThrow(
        "synthetic admission failure",
      );
      expect(readMemoryForgetTombstonesForTest({ agentId: "main" })).toEqual([]);
      expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual(sources);
      expect(db.prepare("SELECT * FROM memory_index_chunks").all()).toEqual(chunks);
      expect(db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()).toEqual(
        revision,
      );
    } finally {
      restore();
    }
    const result = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds });
    expect(result.artifacts.indexSources).toBe(1);
    expect(result.artifacts.indexChunks).toBe(1);
    expect(readMemoryForgetTombstonesForTest({ agentId: "main" })).toHaveLength(130);
    expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM memory_index_chunks").all()).toEqual([]);
  });

  it("removes lineage committed during planning while preserving unrelated content", async () => {
    await seedMemoryForgetSession("target");
    const otherWorkspace = path.join(fixture.stateDir, "other-workspace");
    await fs.mkdir(otherWorkspace);
    const memoryPath = path.join(fixture.workspaceDir, "MEMORY.md");
    const survivor = "Unrelated amber detail stays.\n";
    const content =
      "<!-- openclaw-memory-promotion:late-lineage -->\n- Selected violet detail.\n" + survivor;
    await fs.writeFile(memoryPath, content);
    const { db } = openOpenClawAgentDatabase({ agentId: "main" });
    db.prepare(`INSERT INTO memory_index_chunks
        (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
        VALUES ('selected-snapshot', 'MEMORY.md', 'memory', 1, 3, 'fixture', 'test', ?, x'', 1)`).run(
      content,
    );
    const publishOrigin = () =>
      withMemoryWorkspaceLock(otherWorkspace, async () => {
        await recordMemoryEntryOrigins({
          agentId: "main",
          origins: [
            {
              entryKey: "late-lineage",
              agentId: "main",
              sessionId: "target",
              sessionKey: null,
              originClass: "owner",
              observedAt: 1,
            },
          ],
        });
      });
    const planning = createDeferred<void>();
    const resume = createDeferred<void>();
    const list = storage.listMemoryFiles;
    const planningSpy = vi
      .spyOn(storage, "listMemoryFiles")
      .mockImplementationOnce(async (...args) => {
        const files = await list(...args);
        planning.resolve();
        await resume.promise;
        return files;
      });
    const forgetting = forgetMemoryEntries({
      cfg: fixture.cfg,
      agentId: "main",
      sessionIds: ["target"],
    });
    void forgetting.catch(() => undefined);
    try {
      await Promise.race([
        planning.promise,
        forgetting.then(() => {
          throw new Error("Forget completed before its actual file-planning boundary");
        }),
      ]);
      await publishOrigin();
      expect(await listMemoryEntryOrigins({ agentId: "main" })).toMatchObject([
        { entryKey: "late-lineage", sessionId: "target" },
      ]);
      resume.resolve();
      const report = await forgetting;
      const durable = {
        entryKeys: report.entryKeys,
        memory: await fs.readFile(memoryPath, "utf8"),
        index: db.prepare("SELECT id FROM memory_index_chunks").all(),
        origins: await listMemoryEntryOrigins({ agentId: "main" }),
        targetTombstoned: readMemoryForgetTombstonesForTest({ agentId: "main" }).some(
          ({ sessionId }) => sessionId === "target",
        ),
      };
      expect(durable).toEqual({
        entryKeys: ["late-lineage"],
        memory: survivor,
        index: [],
        origins: [],
        targetTombstoned: true,
      });
    } finally {
      resume.resolve();
      planningSpy.mockRestore();
      await Promise.allSettled([forgetting]);
    }
  });
  it("does not infer hook or participant facts for an archived-only session", async () => {
    const { cfg } = fixture;
    await seedMemoryForgetSession("archived", "gmail");
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.prepare(
      `INSERT INTO session_participants
         (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at)
       VALUES (?, '{"type":"profile"}', 'participant', 1, 1, 1)`,
    ).run("agent:main:archived");
    expect(
      (
        await forgetMemoryEntries({
          cfg,
          agentId: "main",
          participants: ["participant"],
          dryRun: true,
        })
      ).sessionIds,
    ).toEqual(["archived"]);
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: "archived",
      sessionKey: "agent:main:archived",
      message: { role: "user", content: "Archive this session." },
    });
    await deleteSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:archived",
      expectedSessionId: "archived",
      archiveTranscript: true,
    });

    for (const selectors of [{ hookSources: ["gmail"] }, { participants: ["participant"] }]) {
      const report = await forgetMemoryEntries({ cfg, agentId: "main", ...selectors });
      expect(report.sessionIds).toEqual([]);
      expect(report.sessionResolutions).toEqual([]);
    }
    expect(readMemoryForgetTombstonesForTest({ agentId: "main" })).toEqual([]);
  });
  it("previews and forgets selected chunks before optional provenance exists", async () => {
    await seedMemoryForgetSession("target");
    const { db } = openOpenClawAgentDatabase({ agentId: "main" });
    const insert = db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, ?, 'sessions', 1, 1, 'fixture-hash', 'test', 'retained session body', x'', 1)`);
    insert.run("target", "sessions/main/target.jsonl");
    insert.run("keep", "sessions/main/other.jsonl");
    db.exec("DROP TABLE memory_index_chunk_provenance");
    const rows = () => db.prepare("SELECT id FROM memory_index_chunks ORDER BY id").all();
    const before = rows();
    const revision = () => db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get();
    const beforeRevision = revision();
    const params = { cfg: fixture.cfg, agentId: "main", sessionIds: ["target"] };

    const preview = await forgetMemoryEntries({ ...params, dryRun: true });
    expect(preview.artifacts.indexChunks).toBe(1);
    expect(rows()).toEqual(before);
    expect(revision()).toEqual(beforeRevision);
    expect(tableExists(db, "memory_index_chunk_provenance")).toBe(false);

    const applied = await forgetMemoryEntries(params);
    expect(applied.artifacts.indexChunks).toBe(1);
    expect(rows()).toEqual([{ id: "keep" }]);
    expect(tableExists(db, "memory_index_chunk_provenance")).toBe(false);
  });
});
