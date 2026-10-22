import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as storage from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  openOpenClawAgentDatabase,
  openNodeSqliteDatabase,
  resolveOpenClawAgentSqlitePath,
  tableExists,
} from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { pruneMemoryEntryOrigins } from "./memory-entry-origins.js";
import { observeMemoryForgetWorker } from "./memory-forget-fault.test-support.js";
import { readMemoryForgetIndexInWorker } from "./memory-forget-index-read.js";
import { planMemoryIndex } from "./memory-forget-index-sources.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  memoryForgetHarness,
  memoryOrigin,
  memoryIndexFixture,
} from "./memory-forget.suite.test-support.js";
import { seedMemoryForgetSession } from "./memory-forget.test-helpers.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import * as cpuRuntime from "./memory/manager-cpu-worker-runtime.js";

describe("memory forget source removal", () => {
  const h = memoryForgetHarness();
  const { origins, tombstones, readText } = h;
  const { forget } = h;

  function pauseFilePlanning() {
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
    return { planning, resume, planningSpy };
  }

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
      stateDir: h.stateDir,
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
    const options = { agentId: "main", env: { OPENCLAW_STATE_DIR: h.stateDir } };
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
    const alternate = path.join(h.stateDir, "uncreated-alternate");
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
      vi.stubEnv("OPENCLAW_STATE_DIR", h.stateDir);
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
      await closeOpenClawAgentDatabasesAsync(h.stateDir);
      closeOpenClawAgentDatabasesForTest(h.stateDir);
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
                workspaceDir: h.workspaceDir,
                agentIds: ["main"],
                entryKeys: ["candidate"],
                retainedEntryKeys: new Set(),
              })
            : origins();
        await expect(reading()).rejects.toThrow(
          failure === "missing required table"
            ? /missing table memory_index_chunks; run openclaw doctor --fix to repair it/
            : message,
        );
        await expect(
          planMemoryIndex(indexSelection(), {
            agentId: "main",
            path: databasePath,
            env: { OPENCLAW_STATE_DIR: h.stateDir },
          }),
        ).rejects.toThrow(message);
        expect(await fs.readFile(databasePath)).toEqual(beforeRead);
      } finally {
        await closeOpenClawAgentDatabasesAsync(h.stateDir);
        closeOpenClawAgentDatabasesForTest(h.stateDir);
        await fs.writeFile(databasePath, original);
      }
    },
  );

  it.each(["removed", "new mixed contributor", "added"] as const)(
    "retains deletion lineage when it is %s during file planning",
    async (change) => {
      await seedMemoryForgetSession("target");
      const added = change === "added";
      const selected = memoryOrigin(added ? "late-lineage" : "selected-entry", "target", {
        sessionKey: null,
        observedAt: 1,
      });
      const survivor = { ...selected, entryKey: "survivor-entry", sessionId: "survivor" };
      if (!added) {
        await seedMemoryForgetSession("survivor");
        await h.recordOrigins([selected, survivor]);
      }
      const memoryPath = h.path("MEMORY.md");
      const retained = added
        ? "Unrelated amber detail stays.\n"
        : "<!-- openclaw-memory-promotion:survivor-entry -->\n- Retained amber detail.\n";
      const content = `<!-- openclaw-memory-promotion:${selected.entryKey} -->\n- Selected violet detail.\n${retained}`;
      await fs.writeFile(memoryPath, content);
      const db = added
        ? requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db)
        : undefined;
      if (db) {
        memoryIndexFixture(db).chunk("selected-snapshot", "MEMORY.md", {
          source: "memory",
          endLine: 3,
          hash: "fixture",
          text: content,
        });
      }
      const otherWorkspace = path.join(h.stateDir, "other-workspace");
      await fs.mkdir(otherWorkspace);
      const { planning, resume, planningSpy } = pauseFilePlanning();
      const forgetting = forget({ sessionIds: ["target"] });
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
            expect(await origins({ entryKeys: [selected.entryKey] })).toEqual([]);
          } else {
            await h.recordOrigins([added ? selected : { ...selected, sessionId: "survivor" }]);
          }
        });
        if (added) {
          expect(await origins()).toMatchObject([
            { entryKey: "late-lineage", sessionId: "target" },
          ]);
        }
        resume.resolve();
        const report = await forgetting;
        expect({
          entryKeys: report.entryKeys,
          memory: await readText(memoryPath),
          origins: await origins(),
        }).toEqual({
          entryKeys: [selected.entryKey],
          memory: retained,
          origins: added ? [] : [survivor],
        });
        if (db) {
          expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual([]);
          expect(tombstones().some(({ sessionId }) => sessionId === "target")).toBe(true);
        } else {
          expect(report).toMatchObject({
            mixedLineageEntryKeys: change === "new mixed contributor" ? [selected.entryKey] : [],
            untargetableEntryKeys: [],
          });
          expect(tombstones().map(({ sessionId }) => sessionId)).toEqual(["target"]);
        }
      } finally {
        resume.resolve();
        planningSpy.mockRestore();
        await Promise.allSettled([forgetting]);
      }
    },
  );

  it("refuses a retired execution owner without writing to its successor after vector preparation", async () => {
    await seedMemoryForgetSession("target");
    const origin = memoryOrigin("selected-entry", "target", { sessionKey: null, observedAt: 1 });
    await h.recordOrigins([origin]);
    const memoryPath = h.path("MEMORY.md");
    const content =
      "<!-- openclaw-memory-promotion:selected-entry -->\n- Selected violet detail.\n";
    await fs.writeFile(memoryPath, content);
    const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
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
    const forgetting = forget({ sessionIds: ["target"] });
    const settled = forgetting.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const readDurable = async (database: DatabaseSync) => ({
      memory: await readText(memoryPath),
      origins: await origins(),
      tombstones: tombstones(),
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
      closeOpenClawAgentDatabasesForTest(h.stateDir);
      expect(db.isOpen).toBe(false);
      await closeOpenClawAgentDatabasesAsync(h.stateDir);
      const successor = requireNativeSqliteDatabase(
        openOpenClawAgentDatabase({ agentId: "main" }).db,
      );
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
      await closeOpenClawAgentDatabasesAsync(h.stateDir);
    }
  });

  it("forgets 32 sessions with bounded writes and preserves other sources", async () => {
    const sessionCount = 32;
    const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
    const indexData = memoryIndexFixture(db);
    const sessionIds = Array.from({ length: sessionCount }, (_, index) => `target-${index}`);
    const paths = Array.from(
      { length: 32 },
      (_, index) =>
        `sessions/main/${sessionIds[index % sessionCount]!}.jsonl.deleted.2026-08-25T10-00-00.${String(index).padStart(3, "0")}Z.zst`,
    );
    for (const [index, sourcePath] of paths.entries()) {
      indexData.source(sourcePath, "sessions", "remove");
      indexData.chunk(`chunk-${index}`, sourcePath);
      indexData.provenance(`chunk-${index}`);
    }
    indexData.source(paths[0]!, "memory", "keep-memory");
    indexData.source("sessions/main/survivor.jsonl", "sessions", "keep-session");
    const survivors = db
      .prepare("SELECT * FROM memory_index_sources WHERE hash != 'remove' ORDER BY id")
      .all();
    const preview = await forget({ sessionIds, dryRun: true });
    expect(preview.artifacts.indexSources).toBe(32);
    expect(db.prepare("SELECT count(*) AS count FROM memory_index_sources").get()).toEqual({
      count: 34,
    });
    const reportPath = path.join(h.stateDir, "forget-native-counts.jsonl");
    const restore = observeMemoryForgetWorker(db, { reportPath });
    try {
      const result = await forget({ sessionIds });
      expect(result).toEqual({ ...preview, dryRun: false });
      expect(db.prepare("SELECT * FROM memory_index_sources ORDER BY id").all()).toEqual(survivors);
      expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual([]);
      expect(tombstones()).toMatchObject(
        sessionIds.toSorted().map((sessionId) => ({ sessionId, reason: "forgotten" })),
      );
      let sourceDeletes = 0;
      let tombstoneInserts = 0;
      const reports = (await readText(reportPath)).trim().split("\n");
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
    const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
    const sessionIds = Array.from({ length: 130 }, (_, index) => `target-${index}`);
    const indexData = memoryIndexFixture(db);
    indexData.source("sessions/main/target-0.jsonl", "sessions", "keep-until-admitted");
    indexData.chunk("target-chunk", "sessions/main/target-0.jsonl", { hash: "hash" });
    indexData.provenance("target-chunk");
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
      await expect(forget({ sessionIds })).rejects.toThrow("synthetic admission failure");
      expect(tombstones()).toEqual([]);
      expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual(sources);
      expect(db.prepare("SELECT * FROM memory_index_chunks").all()).toEqual(chunks);
      expect(db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()).toEqual(
        revision,
      );
    } finally {
      restore();
    }
    const result = await forget({ sessionIds });
    expect(result.artifacts.indexSources).toBe(1);
    expect(result.artifacts.indexChunks).toBe(1);
    expect(tombstones()).toHaveLength(130);
    expect(db.prepare("SELECT * FROM memory_index_sources").all()).toEqual([]);
    expect(db.prepare("SELECT * FROM memory_index_chunks").all()).toEqual([]);
  });

  it("does not infer hook or participant facts for an archived-only session", async () => {
    await seedMemoryForgetSession("archived", "gmail");
    const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
    db.prepare(
      `INSERT INTO session_participants
         (session_key, identity_namespace, actor_id, contribution_count, first_prompted_at, last_prompted_at)
       VALUES (?, '{"type":"profile"}', 'participant', 1, 1, 1)`,
    ).run("agent:main:archived");
    expect((await forget({ participants: ["participant"], dryRun: true })).sessionIds).toEqual([
      "archived",
    ]);
    await h.append("archived", { role: "user", content: "Archive this session." });
    await h.archive("archived");

    for (const selectors of [{ hookSources: ["gmail"] }, { participants: ["participant"] }]) {
      const report = await forget({ ...selectors });
      expect(report.sessionIds).toEqual([]);
      expect(report.sessionResolutions).toEqual([]);
    }
    expect(tombstones()).toEqual([]);
  });
  it("previews and forgets selected chunks before optional provenance exists", async () => {
    await seedMemoryForgetSession("target");
    const db = requireNativeSqliteDatabase(openOpenClawAgentDatabase({ agentId: "main" }).db);
    const indexData = memoryIndexFixture(db);
    indexData.chunk("target", "sessions/main/target.jsonl", { text: "retained session body" });
    indexData.chunk("keep", "sessions/main/other.jsonl", { text: "retained session body" });
    db.exec("DROP TABLE memory_index_chunk_provenance");
    const rows = () => db.prepare("SELECT id FROM memory_index_chunks ORDER BY id").all();
    const before = rows();
    const revision = () => db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get();
    const beforeRevision = revision();
    const params = { cfg: h.cfg, agentId: "main", sessionIds: ["target"] };

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
