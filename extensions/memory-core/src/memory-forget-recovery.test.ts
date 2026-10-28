import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  openOpenClawStateDatabase,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import {
  readSessionIngestionState,
  writeSessionIngestionState,
} from "./dreaming-ingestion-state.js";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  SHORT_TERM_META_NAMESPACE,
  SHORT_TERM_PHASE_SIGNAL_NAMESPACE,
  memoryCoreWorkspaceStateKey,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { observeMemoryForgetWorker } from "./memory-forget-fault.test-support.js";
import {
  memoryForgetHarness,
  memoryOrigin,
  memoryBackup,
  memoryIndexFixture,
} from "./memory-forget.suite.test-support.js";
import { seedMemoryForgetSession } from "./memory-forget.test-helpers.js";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { memoryCpuProcessEntrypoints } from "./memory/manager-cpu-entrypoints.js";
import { readPhaseSignalStore, writePhaseSignalStore } from "./short-term-promotion-store.js";
import type {
  ShortTermPhaseSignalEntry,
  ShortTermRecallEntry,
} from "./short-term-promotion-types.js";

const h = memoryForgetHarness();
const { origins, tombstones, readText } = h;
const targetTombstone = { agentId: "main", sessionId: "target", reason: "forgotten" };

describe("memory forget", () => {
  const forget = (dryRun = false) => h.forget({ hookSources: ["gmail"], dryRun });

  it.each([
    { failure: "none", corpusExtension: "txt" },
    { failure: "index", corpusExtension: "txt" },
    { failure: "sources", corpusExtension: "txt" },
    { failure: "backup", corpusExtension: "txt" },
    { failure: "memory", corpusExtension: "txt" },
    { failure: "corpus", corpusExtension: "txt" },
    { failure: "origins", corpusExtension: "txt" },
    { failure: "memory", corpusExtension: "md" },
  ])(
    "durably purges every derived owner after a $failure failure with $corpusExtension corpus",
    async ({ failure, corpusExtension }) => {
      await seedMemoryForgetSession("survivor");
      await seedMemoryForgetSession("target", "gmail");
      await h.recordOrigins([
        memoryOrigin("mixed-entry", "target"),
        memoryOrigin("mixed-entry", "survivor"),
        memoryOrigin("clean-entry", "survivor"),
      ]);
      const memoryContent = [
        "# Long-Term Memory",
        "Curated operator fact.",
        "<!-- openclaw-memory-lineage:old-lineage -->",
        "<!-- openclaw-memory-promotion:mixed-entry -->",
        "- Erase the mixed secret.",
        "<!-- openclaw-memory-promotion:clean-entry -->",
        "- Keep the clean fact.",
        "<!-- openclaw-memory-promotion:legacy-entry -->",
        "- Preserve an untargetable legacy fact.",
        "",
      ].join("\n");
      await h.write("MEMORY.md", memoryContent);
      await h.write("USER.md", "# User\nCurated private profile.\n");
      const sourceSnippet = "User: Please remember violet-mongoose-42.";
      const assistantSnippet = "Assistant: The launch code is violet-mongoose-42.";
      const lightDiaryPath = h.path("memory", "dreaming", "light", "2026-08-26.md");
      const rootDiaryPath = h.path("DREAMS.md");
      await fs.mkdir(path.dirname(lightDiaryPath), { recursive: true });
      await fs.writeFile(
        lightDiaryPath,
        `# Light Dream\n- Candidate: ${sourceSnippet}\n- Candidate: Keep an unrelated memory.\n`,
      );
      await fs.writeFile(rootDiaryPath, `# Dream Diary\n- Candidate: ${assistantSnippet}\n`);
      const corpusDir = h.path("memory", ".dreams", "session-corpus");
      await fs.mkdir(corpusDir, { recursive: true });
      const mixedCorpusPath = path.join(corpusDir, `2026-08-25.${corpusExtension}`);
      const removedCorpusPath = path.join(corpusDir, `2026-08-26.${corpusExtension}`);
      await fs.writeFile(
        mixedCorpusPath,
        `[main/sessions/main/target#L1] ${sourceSnippet}\n[main/sessions/main/survivor#L1] keep\n`,
      );
      await fs.writeFile(removedCorpusPath, `[main/sessions/main/target#L2] ${assistantSnippet}\n`);
      await h.writeEntries(
        SHORT_TERM_RECALL_NAMESPACE,
        Object.entries({ "mixed-entry": "erase", "clean-entry": "keep" }).map(([key, snippet]) => ({
          key,
          value: { key, path: "memory/source.md", snippet },
        })),
      );
      await writePhaseSignalStore(h.workspaceDir, {
        version: 1,
        updatedAt: "2026-08-26T00:00:00.000Z",
        entries: {
          "mixed-entry": { key: "mixed-entry", lightHits: 1, remHits: 0 },
          "clean-entry": { key: "clean-entry", lightHits: 0, remHits: 1 },
        },
      });
      await writeSessionIngestionState(h.workspaceDir, {
        version: 3,
        files: {
          "main:sessions/main/target": {
            mtimeMs: 1,
            size: 1,
            contentHash: "hash",
            lineCount: 1,
            lastContentLine: 1,
          },
        },
        seenMessages: {
          "main:sessions/main/target": ["target-hash"],
          "main:sessions/main/survivor": ["survivor-hash"],
        },
      });
      await h.writeEntries(DREAMING_MEMORY_BACKUP_NAMESPACE, [
        memoryBackup(`${memoryContent}- Candidate: ${sourceSnippet}\n`),
      ]);

      const agentDatabase = openOpenClawAgentDatabase({ agentId: "main" });
      const db = requireNativeSqliteDatabase(agentDatabase.db);
      await loadSqliteVecExtension({ db });
      ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
      db.exec(
        "CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[2])",
      );
      const transcriptPath = path.join(h.stateDir, "agents", "main", "sessions", "target.jsonl");
      await fs.mkdir(path.dirname(transcriptPath), { recursive: true });
      await fs.writeFile(transcriptPath, "source transcript survives deletion\n");
      const narrativeSessionId = "3cb3f634-6821-4123-8123-abcdef123456";
      const narrativeArchiveName = `${narrativeSessionId}.jsonl.deleted.2026-08-26T10-00-00.000Z.zst`;
      const narrativeArchivePath = path.join(path.dirname(transcriptPath), narrativeArchiveName);
      const narrativeTranscript = [
        {
          type: "message",
          message: { role: "user", content: `Write a dream diary entry: ${sourceSnippet}` },
        },
        {
          type: "session",
          sessionKey: "agent:main:dreaming-narrative-memory-core-v2-light-orphan",
        },
      ];
      await fs.writeFile(
        narrativeArchivePath,
        zstdCompressSync(
          `${narrativeTranscript.map((record) => JSON.stringify(record)).join("\n")}\n`,
        ),
      );
      const indexedFiles = [
        ["MEMORY.md", "memory"],
        [`memory/.dreams/session-corpus/2026-08-26.${corpusExtension}`, "memory"],
        ["sessions/main/target.jsonl.reset.2026-08-25T10-00-00.000Z.zst", "sessions"],
        [`sessions/main/${narrativeArchiveName}`, "sessions", "unknown", "violet"],
        ["sessions/main/survivor.jsonl.deleted.2026-08-25T10-00-00.000Z.zst", "sessions"],
      ] as const;
      const indexData = memoryIndexFixture(db);
      for (const [index, file] of indexedFiles.entries()) {
        const [filePath, source, sessionKind = "interactive", text = "erase"] = file;
        const chunkId = `chunk-${index}`;
        const hash = `hash-${index}`;
        indexData.chunk(chunkId, filePath, {
          source,
          hash,
          text,
          embedding: encodeMemoryEmbedding([1, 0]),
        });
        indexData.source(filePath, source, hash);
        db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
          chunkId,
          new Float32Array([1, 0]),
        );
        db.prepare(
          `INSERT INTO memory_embedding_cache
          (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES ('test', 'test', 'test', ?, ?, 2, 1)`,
        ).run(hash, encodeMemoryEmbedding([1, 0]));
        indexData.provenance(chunkId, "owner", sessionKind);
      }
      db.exec("DROP TABLE IF EXISTS memory_session_tombstones");
      const revision = () => {
        const value = db
          .prepare("SELECT revision FROM memory_index_state WHERE id = 1")
          .get()?.revision;
        assert(typeof value === "number");
        return value;
      };
      const revisionBefore = revision();

      const preview = await forget(true);
      expect(preview).toMatchObject({
        dryRun: true,
        sessionIds: ["target"],
        entryKeys: ["mixed-entry"],
        mixedLineageEntryKeys: ["mixed-entry"],
        untargetableEntryKeys: ["legacy-entry"],
        artifacts: {
          memoryFiles: 3,
          memoryEntries: 1,
          memoryLines: 2,
          sessionCorpusFiles: 2,
          sessionCorpusLines: 2,
          indexChunks: 4,
          indexSources: 3,
          ftsRows: 4,
          vectorRows: 4,
          embeddingCacheRows: 5,
          shortTermEntries: 1,
          seenHashScopes: 1,
          backups: 1,
          originRows: 2,
        },
      });
      expect(await h.read("MEMORY.md")).toBe(memoryContent);
      expect(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("memory_session_tombstones"),
      ).toBeUndefined();
      expect(revision()).toBe(revisionBefore);

      if (failure !== "none") {
        const failureMessage = `synthetic ${failure} storage failure`;
        if (failure === "memory" || failure === "corpus") {
          const open = fs.open.bind(fs);
          const failedPath = failure === "memory" ? h.path("MEMORY.md") : mixedCorpusPath;
          const failedTempPrefix = `${failedPath}.forget.`;
          const fault = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const target = args[0];
            if (typeof target === "string" && target.startsWith(failedTempPrefix)) {
              throw new Error(failureMessage);
            }
            return await open(...args);
          });
          try {
            await expect(forget()).rejects.toThrow(failureMessage);
          } finally {
            fault.mockRestore();
          }
        } else {
          const trigger =
            failure === "backup"
              ? "BEFORE UPDATE ON plugin_state_entries WHEN OLD.plugin_id = 'memory-core' AND OLD.namespace = 'dreaming-memory-backups'"
              : failure === "index"
                ? "BEFORE DELETE ON memory_index_chunks WHEN OLD.id = 'chunk-0'"
                : failure === "sources"
                  ? "BEFORE DELETE ON memory_index_sources WHEN OLD.source = 'sessions'"
                  : "BEFORE DELETE ON memory_entry_origins WHEN OLD.entry_key = 'mixed-entry'";
          const restore =
            failure === "backup"
              ? (() => {
                  const faultDb = openOpenClawStateDatabase().db;
                  faultDb.exec(
                    `CREATE TRIGGER abort_forget ${trigger} BEGIN SELECT RAISE(ABORT, '${failureMessage}'); END`,
                  );
                  return () => faultDb.exec("DROP TRIGGER abort_forget");
                })()
              : observeMemoryForgetWorker(db, {
                  trigger: { event: trigger, message: failureMessage, action: "ABORT" },
                });
          try {
            await expect(forget()).rejects.toMatchObject(
              failure === "backup"
                ? { cause: { message: failureMessage } }
                : { message: failureMessage },
            );
          } finally {
            restore();
          }
        }
        expect(tombstones()).toMatchObject([{ sessionId: "target", reason: "forgotten" }]);
      }
      const retryPreview = await forget(true);
      const report = await forget();
      expect(report).toEqual({ ...retryPreview, dryRun: false });
      const survivingMemory = await h.read("MEMORY.md");
      expect(survivingMemory).toContain("Curated operator fact.");
      expect(survivingMemory).toContain("Keep the clean fact.");
      expect(survivingMemory).toContain("Preserve an untargetable legacy fact.");
      expect(survivingMemory).not.toContain("mixed secret");
      expect(survivingMemory).not.toContain("old-lineage");
      expect(await readText(lightDiaryPath)).toBe(
        "# Light Dream\n- Candidate: Keep an unrelated memory.\n",
      );
      expect(await readText(rootDiaryPath)).toBe("# Dream Diary\n");
      expect(await h.read("USER.md")).toContain("Curated");
      expect(await readText(mixedCorpusPath)).toBe("[main/sessions/main/survivor#L1] keep\n");
      await expect(fs.stat(removedCorpusPath)).rejects.toMatchObject({ code: "ENOENT" });
      for (const table of [
        "memory_index_chunks",
        "memory_index_chunks_fts",
        "memory_index_chunks_vec",
        "memory_index_chunk_provenance",
      ]) {
        expect(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 1 });
      }
      expect(db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get()).toEqual({
        count: 0,
      });
      expect(db.prepare("SELECT path FROM memory_index_sources").all()).toEqual([
        { path: "MEMORY.md" },
        { path: "sessions/main/survivor.jsonl.deleted.2026-08-25T10-00-00.000Z.zst" },
      ]);
      expect(
        db
          .prepare("SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?")
          .all("violet"),
      ).toEqual([]);
      expect(await readText(transcriptPath)).toBe("source transcript survives deletion\n");
      expect(revision()).toBeGreaterThan(revisionBefore);
      expect((await h.readEntries(SHORT_TERM_RECALL_NAMESPACE)).map((entry) => entry.key)).toEqual([
        "clean-entry",
      ]);
      expect(
        Object.keys((await readPhaseSignalStore(h.workspaceDir, new Date().toISOString())).entries),
      ).toEqual(["clean-entry"]);
      expect((await readSessionIngestionState(h.workspaceDir)).seenMessages).toEqual({
        "main:sessions/main/survivor": ["survivor-hash"],
      });
      const backups = await h.readEntries<{
        content: string;
        contentHash: string;
      }>(DREAMING_MEMORY_BACKUP_NAMESPACE);
      expect(backups[0]?.value.content).not.toContain("mixed secret");
      expect(backups[0]?.value.content).not.toContain(sourceSnippet);
      expect(backups[0]?.value.contentHash).toBe(
        createHash("sha256").update(backups[0]!.value.content).digest("hex"),
      );
      expect((await origins()).map((origin) => origin.entryKey)).toEqual(["clean-entry"]);
      const savedTombstones = tombstones();
      expect(savedTombstones).toEqual([{ ...targetTombstone, createdAt: expect.any(Number) }]);

      const repeated = await forget();
      expect(repeated.sessionIds).toEqual(["target"]);
      expect(Object.values(repeated.artifacts).every((count) => count === 0)).toBe(true);
      expect(tombstones()).toEqual(savedTombstones);
    },
  );
});

const observedAt = "2026-09-11T00:00:00.000Z";

type RecallFixture = Pick<ShortTermRecallEntry, "key" | "path" | "snippet" | "recallCount">;
function recallEntry(key: string): RecallFixture {
  return {
    key,
    path: "memory/2026-09-11.md",
    snippet: `Synthetic memory fact for ${key}.`,
    recallCount: 1,
  };
}

describe("memory forget phase-signal failures", () => {
  const forget = () => h.forget({ sessionIds: ["target"] });

  const readRecalls = () => h.readEntries<RecallFixture>(SHORT_TERM_RECALL_NAMESPACE);
  const readPhases = async () => (await readPhaseSignalStore(h.workspaceDir, observedAt)).entries;
  function abortWrite(event: string, namespace: string, key: string, message: string) {
    const db = openOpenClawStateDatabase().db;
    db.exec(`CREATE TRIGGER abort_write ${event} ON plugin_state_entries
      WHEN OLD.plugin_id = 'memory-core' AND OLD.namespace = '${namespace}'
        AND json_extract(OLD.value_json, '$.workspaceKey') = '${memoryCoreWorkspaceStateKey(h.workspaceDir)}'
        AND json_extract(OLD.value_json, '$.key') = '${key}'
      BEGIN SELECT RAISE(ABORT, '${message}'); END;`);
    return () => db.exec("DROP TRIGGER IF EXISTS abort_write");
  }

  async function seedEntries(survivorKeys: string[]) {
    await seedMemoryForgetSession("target");
    await seedMemoryForgetSession("survivor");
    const keys = ["target-entry", ...survivorKeys];
    const recalls = keys.map((key) => ({ key, value: recallEntry(key) }));
    const phases: Record<string, ShortTermPhaseSignalEntry> = Object.fromEntries(
      keys.map((key) => [
        key,
        { key, lightHits: 2, remHits: 1, lastLightAt: observedAt, lastRemAt: observedAt },
      ]),
    );
    await h.recordOrigins(
      keys.map((entryKey) =>
        memoryOrigin(entryKey, entryKey === "target-entry" ? "target" : "survivor", {
          observedAt: Date.parse(observedAt),
        }),
      ),
    );
    await h.writeEntries(SHORT_TERM_RECALL_NAMESPACE, recalls);
    await writePhaseSignalStore(h.workspaceDir, {
      version: 1,
      updatedAt: observedAt,
      entries: phases,
    });
    return { recalls, phases, origins: await origins() };
  }

  it("preserves a later phase write after phase metadata failure", async () => {
    // Eleven retained writes cross the workspace store's cooperative yield.
    const survivorKeys = Array.from({ length: 11 }, (_, index) => `survivor-${index}`);
    const before = await seedEntries(survivorKeys);
    await h.writeEntry(SHORT_TERM_RECALL_NAMESPACE, "later-entry", recallEntry("later-entry"));
    const rowsSettled = createDeferred<void>();
    const restore = abortWrite(
      "BEFORE UPDATE",
      SHORT_TERM_META_NAMESPACE,
      "phase",
      "synthetic phase metadata failure",
    );
    const writeEntries = writeMemoryCoreWorkspaceEntries;
    let rowsStarted = false;
    const rowWrites = vi
      .spyOn(await import("./dreaming-state.js"), "writeMemoryCoreWorkspaceEntries")
      .mockImplementation(async (params) => {
        if (params.namespace === SHORT_TERM_PHASE_SIGNAL_NAMESPACE) {
          rowsStarted = true;
        }
        try {
          await writeEntries(params);
        } finally {
          if (params.namespace === SHORT_TERM_PHASE_SIGNAL_NAMESPACE) {
            rowsSettled.resolve();
          }
        }
      });
    const laterPhase: ShortTermPhaseSignalEntry = {
      key: "later-entry",
      lightHits: 7,
      remHits: 2,
      lastLightAt: observedAt,
      lastRemAt: observedAt,
    };

    try {
      await expect(forget()).rejects.toMatchObject({
        cause: { message: "synthetic phase metadata failure" },
      });
      restore();
      await withMemoryWorkspaceLock(h.workspaceDir, () =>
        h.writeEntry(SHORT_TERM_PHASE_SIGNAL_NAMESPACE, "later-entry", laterPhase),
      );
      await rowsSettled.promise;
      const storedPhases = await readPhases();
      expect(storedPhases["later-entry"]).toEqual(laterPhase);
      expect(storedPhases["target-entry"]).toBeUndefined();
      for (const key of survivorKeys) {
        expect(storedPhases[key]).toEqual(before.phases[key]);
      }
      expect(await readRecalls()).toEqual(expect.arrayContaining(before.recalls));
      expect(await origins()).toEqual(before.origins);
      const savedTombstones = tombstones();
      expect(savedTombstones).toMatchObject([{ sessionId: "target", reason: "forgotten" }]);

      await forget();
      expect((await readRecalls()).map(({ key }) => key)).not.toContain("target-entry");
      expect(await origins({ sessionIds: ["target"] })).toEqual([]);
      expect(tombstones()).toEqual(savedTombstones);
      expect(await readPhases()).toEqual(storedPhases);
    } finally {
      restore();
      if (rowsStarted) {
        await rowsSettled.promise;
      }
      rowWrites.mockRestore();
    }
  });

  it.each([
    { failure: "phase", namespace: SHORT_TERM_PHASE_SIGNAL_NAMESPACE, targetPhaseRemains: true },
    { failure: "recall", namespace: SHORT_TERM_RECALL_NAMESPACE, targetPhaseRemains: false },
  ])(
    "retains retry evidence after $failure row deletion fails",
    async ({ namespace, targetPhaseRemains }) => {
      const before = await seedEntries(["survivor-entry"]);
      const restore = abortWrite(
        "BEFORE DELETE",
        namespace,
        "target-entry",
        "synthetic target deletion failure",
      );
      try {
        await expect(forget()).rejects.toMatchObject({
          cause: { message: "synthetic target deletion failure" },
        });
      } finally {
        restore();
      }
      expect(await readRecalls()).toEqual(expect.arrayContaining(before.recalls));
      expect(await origins()).toEqual(before.origins);
      const storedPhases = await readPhases();
      expect(storedPhases["target-entry"]).toEqual(
        targetPhaseRemains ? before.phases["target-entry"] : undefined,
      );
      expect(storedPhases["survivor-entry"]).toEqual(before.phases["survivor-entry"]);
      const savedTombstones = tombstones();
      expect(savedTombstones).toMatchObject([{ sessionId: "target", reason: "forgotten" }]);

      await forget();
      expect(await readRecalls()).toEqual([
        { key: "survivor-entry", value: recallEntry("survivor-entry") },
      ]);
      expect(await readPhases()).toEqual({
        "survivor-entry": before.phases["survivor-entry"],
      });
      expect(await origins({ sessionIds: ["target"] })).toEqual([]);
      expect(await origins({ sessionIds: ["survivor"] })).toEqual(
        before.origins.filter(({ sessionId }) => sessionId === "survivor"),
      );
      expect(tombstones()).toEqual(savedTombstones);
    },
  );
});

describe("memory forget worker settlement", () => {
  const forget = () => h.forget({ sessionIds: ["target"] });
  const empty = { chunks: [], sources: [], cache: [] };

  async function seedSelectedMemory(withOrigins: boolean) {
    await seedMemoryForgetSession("target");
    const db = requireNativeSqliteDatabase(
      sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" }).db,
    );
    if (withOrigins) {
      await h.recordOrigins([memoryOrigin("selected-entry", "target")]);
    } else {
      db.exec("DROP TABLE IF EXISTS memory_entry_origins");
    }
    db.exec("DROP TABLE IF EXISTS memory_session_tombstones");
    const retained = "# Memory\nKeep the unrelated amber fact.\n";
    const selected = withOrigins
      ? "<!-- openclaw-memory-promotion:selected-entry -->\n- Private violet fact.\n"
      : "## Session ID: target\n- Private violet fact.\n";
    await h.write("MEMORY.md", retained + selected);
    const index = memoryIndexFixture(db);
    index.source("sessions/main/target.jsonl", "sessions", "selected");
    index.chunk("selected-chunk", "sessions/main/target.jsonl", {
      hash: "selected",
      model: "fixture",
      text: "Private violet fact.",
    });
    db.prepare(
      "INSERT INTO memory_embedding_cache (provider, model, provider_key, hash, embedding, dims, updated_at) VALUES ('fixture', 'fixture', 'fixture', 'selected', ?, 1, 1)",
    ).run(encodeMemoryEmbedding([1]));
    const rows = (sql: string) => db.prepare(sql).all();
    const derived = () => ({
      chunks: rows("SELECT * FROM memory_index_chunks ORDER BY id"),
      sources: rows("SELECT * FROM memory_index_sources ORDER BY id"),
      cache: rows("SELECT * FROM memory_embedding_cache ORDER BY hash"),
    });
    const optionalTables = () =>
      rows(
        "SELECT name FROM sqlite_schema WHERE name IN ('memory_entry_origins', 'memory_session_tombstones') ORDER BY name",
      );
    const snapshot = async () => ({
      derived: derived(),
      revision: Number(
        db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()?.revision,
      ),
      memory: await h.read("MEMORY.md"),
    });
    return { db, retained, derived, optionalTables, snapshot };
  }

  it.each(["forget.mark", "forget.purge"] as const)(
    "stops after the real %s commit loses its result and completes only on explicit retry",
    async (failResult) => {
      const state = await seedSelectedMemory(true);
      const before = await state.snapshot();
      const savedOrigins = await h.origins();
      const restore = observeMemoryForgetWorker(state.db, { failResult });
      try {
        await expect(forget()).rejects.toMatchObject({
          message: expect.stringContaining("injected committed " + failResult + " reply failure"),
        });
        const savedTombstones = h.tombstones();
        expect(savedTombstones).toEqual([{ ...targetTombstone, createdAt: expect.any(Number) }]);
        expect(await state.snapshot()).toEqual({
          ...before,
          derived: failResult === "forget.mark" ? before.derived : empty,
          revision: before.revision + (failResult === "forget.mark" ? 1 : 2),
        });
        expect(await h.origins()).toEqual(savedOrigins);
        restore();
        await forget();
        expect(await state.snapshot()).toEqual({
          derived: empty,
          revision: before.revision + 3,
          memory: state.retained,
        });
        expect(await h.origins()).toEqual([]);
        expect(h.tombstones()).toEqual(savedTombstones);
      } finally {
        restore();
      }
    },
  );

  it.each(["schema commit", "business transaction"] as const)(
    "preserves first-use schema boundaries when %s admission is refused",
    async (refusal) => {
      const state = await seedSelectedMemory(false);
      const before = await state.snapshot();
      const version = state.db.prepare("PRAGMA user_version").get();
      expect(state.optionalTables()).toEqual([]);
      const schemaCommit = refusal === "schema commit";
      const originalError = new Error("injected " + refusal + " refusal");
      let transactions = 0;
      let refused = false;
      const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
      const observer = vi
        .spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2")
        .mockImplementation((options, source, worker) => {
          if (
            options.path !== state.db.location() ||
            worker.moduleUrl.href !==
              resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.entryOrigins).href
          ) {
            return open(options, source, worker);
          }
          return open(options, source, {
            ...worker,
            assertAdmission(request) {
              const original = worker.assertAdmission ? worker.assertAdmission(request) : request;
              if (original.stage === "transaction") {
                transactions++;
              }
              if (
                original.stage === (schemaCommit ? "commit" : "transaction") &&
                transactions === (schemaCommit ? 1 : 2)
              ) {
                refused = true;
                throw originalError;
              }
              return original;
            },
          });
        });
      try {
        // Failed factory retirement takes precedence over the schema refusal.
        await expect(forget()).rejects.toMatchObject(
          schemaCommit
            ? {
                code: "outcome-unknown",
                message: expect.stringContaining("Agent publication binding did not settle"),
              }
            : { message: expect.stringContaining(originalError.message) },
        );
        expect(refused).toBe(true);
        expect(state.optionalTables()).toEqual(
          schemaCommit ? [] : [{ name: "memory_session_tombstones" }],
        );
        expect(h.tombstones()).toEqual([]);
        expect(await state.snapshot()).toEqual(before);
        expect(state.db.prepare("PRAGMA user_version").get()).toEqual(version);
        observer.mockRestore();
        await forget();
        expect(state.optionalTables()).toEqual([{ name: "memory_session_tombstones" }]);
        expect(state.derived()).toEqual(empty);
        const memory = await h.read("MEMORY.md");
        expect(memory).not.toContain("Private violet fact.");
        expect(memory).toContain("Keep the unrelated amber fact.");
        expect(h.tombstones()).toMatchObject([{ sessionId: "target", reason: "forgotten" }]);
        expect(state.db.prepare("PRAGMA user_version").get()).toEqual(version);
      } finally {
        observer.mockRestore();
      }
    },
  );
});
