import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  encodeMemoryEmbedding,
  ensureMemoryIndexSchema,
  loadSqliteVecExtension,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { openOpenClawAgentDatabase } from "openclaw/plugin-sdk/sqlite-runtime";
import { openOpenClawStateDatabase } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readSessionIngestionState,
  writeSessionIngestionState,
} from "./dreaming-ingestion-state.js";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  SHORT_TERM_RECALL_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import { listMemoryEntryOrigins, recordMemoryEntryOrigins } from "./memory-entry-origins.js";
import { observeMemoryForgetWorker } from "./memory-forget-fault.test-support.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";
import { observePublishedSql } from "./memory/manager-publication-observer.test-support.js";
import { readPhaseSignalStore, writePhaseSignalStore } from "./short-term-promotion-store.js";
import { readMemoryForgetTombstonesForTest } from "./test-helpers.js";

describe("memory forget", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  let stateDir: string;
  let workspaceDir: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    fixture = await createMemoryForgetFixture();
    ({ stateDir, workspaceDir, cfg } = fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

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
      await recordMemoryEntryOrigins({
        agentId: "main",
        origins: [
          {
            entryKey: "mixed-entry",
            agentId: "main",
            sessionId: "target",
            sessionKey: "agent:main:target",
            originClass: "owner",
            observedAt: 1_000,
          },
          {
            entryKey: "mixed-entry",
            agentId: "main",
            sessionId: "survivor",
            sessionKey: "agent:main:survivor",
            originClass: "owner",
            observedAt: 1_000,
          },
          {
            entryKey: "clean-entry",
            agentId: "main",
            sessionId: "survivor",
            sessionKey: "agent:main:survivor",
            originClass: "owner",
            observedAt: 1_000,
          },
        ],
      });
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
      await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memoryContent);
      await fs.writeFile(path.join(workspaceDir, "USER.md"), "# User\nCurated private profile.\n");
      const sourceSnippet = "User: Please remember violet-mongoose-42.";
      const assistantSnippet = "Assistant: The launch code is violet-mongoose-42.";
      const lightDiaryPath = path.join(
        workspaceDir,
        "memory",
        "dreaming",
        "light",
        "2026-08-26.md",
      );
      const rootDiaryPath = path.join(workspaceDir, "DREAMS.md");
      await fs.mkdir(path.dirname(lightDiaryPath), { recursive: true });
      await fs.writeFile(
        lightDiaryPath,
        `# Light Dream\n- Candidate: ${sourceSnippet}\n- Candidate: Keep an unrelated memory.\n`,
      );
      await fs.writeFile(rootDiaryPath, `# Dream Diary\n- Candidate: ${assistantSnippet}\n`);
      const corpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
      await fs.mkdir(corpusDir, { recursive: true });
      const mixedCorpusPath = path.join(corpusDir, `2026-08-25.${corpusExtension}`);
      const removedCorpusPath = path.join(corpusDir, `2026-08-26.${corpusExtension}`);
      await fs.writeFile(
        mixedCorpusPath,
        `[main/sessions/main/target#L1] ${sourceSnippet}\n[main/sessions/main/survivor#L1] keep\n`,
      );
      await fs.writeFile(removedCorpusPath, `[main/sessions/main/target#L2] ${assistantSnippet}\n`);
      await writeMemoryCoreWorkspaceEntries({
        namespace: SHORT_TERM_RECALL_NAMESPACE,
        workspaceDir,
        entries: [
          {
            key: "mixed-entry",
            value: { key: "mixed-entry", path: "memory/source.md", snippet: "erase" },
          },
          {
            key: "clean-entry",
            value: { key: "clean-entry", path: "memory/source.md", snippet: "keep" },
          },
        ],
      });
      await writePhaseSignalStore(workspaceDir, {
        version: 1,
        updatedAt: "2026-08-26T00:00:00.000Z",
        entries: {
          "mixed-entry": { key: "mixed-entry", lightHits: 1, remHits: 0 },
          "clean-entry": { key: "clean-entry", lightHits: 0, remHits: 1 },
        },
      });
      await writeSessionIngestionState(workspaceDir, {
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
      await writeMemoryCoreWorkspaceEntries({
        namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
        workspaceDir,
        entries: [
          {
            key: "backup",
            value: {
              createdAt: "2026-08-25T00:00:00.000Z",
              content: `${memoryContent}- Candidate: ${sourceSnippet}\n`,
              contentHash: createHash("sha256")
                .update(`${memoryContent}- Candidate: ${sourceSnippet}\n`)
                .digest("hex"),
            },
          },
        ],
      });

      const agentDatabase = openOpenClawAgentDatabase({ agentId: "main" });
      const db = agentDatabase.db;
      const loaded = await loadSqliteVecExtension({ db });
      expect(loaded.ok).toBe(true);
      const schema = ensureMemoryIndexSchema({ db, cacheEnabled: true, ftsEnabled: true });
      expect(schema.ftsAvailable, schema.ftsError).toBe(true);
      db.exec(`
      CREATE VIRTUAL TABLE memory_index_chunks_vec USING vec0(
        id TEXT PRIMARY KEY, embedding FLOAT[2]
      );
    `);
      const transcriptPath = path.join(stateDir, "agents", "main", "sessions", "target.jsonl");
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
      expect(
        db
          .prepare("SELECT session_id FROM session_windows WHERE session_id = ?")
          .get(narrativeSessionId),
      ).toBeUndefined();
      const indexedFiles = [
        { path: "MEMORY.md", source: "memory", originClass: "owner" },
        {
          path: `memory/.dreams/session-corpus/2026-08-26.${corpusExtension}`,
          source: "memory",
          originClass: "owner",
        },
        {
          path: "sessions/main/target.jsonl.reset.2026-08-25T10-00-00.000Z.zst",
          source: "sessions",
          originClass: "owner",
        },
        {
          path: `sessions/main/${narrativeArchiveName}`,
          source: "sessions",
          originClass: "owner",
          sessionKind: "unknown",
          text: "violet",
        },
        {
          path: "sessions/main/survivor.jsonl.deleted.2026-08-25T10-00-00.000Z.zst",
          source: "sessions",
          originClass: "owner",
        },
      ];
      for (const [index, file] of indexedFiles.entries()) {
        const chunkId = `chunk-${index}`;
        const hash = `hash-${index}`;
        const text = file.text ?? "erase";
        db.prepare(
          `INSERT INTO memory_index_chunks (
          id, path, source, start_line, end_line, hash, model, text, embedding, updated_at
        ) VALUES (?, ?, ?, 1, 1, ?, 'test', ?, ?, 1)`,
        ).run(chunkId, file.path, file.source, hash, text, encodeMemoryEmbedding([1, 0]));
        db.prepare(
          "INSERT INTO memory_index_sources (path, source, hash, mtime, size) VALUES (?, ?, ?, 1, 1)",
        ).run(file.path, file.source, hash);
        db.prepare("INSERT INTO memory_index_chunks_vec (id, embedding) VALUES (?, ?)").run(
          chunkId,
          new Float32Array([1, 0]),
        );
        db.prepare(
          `INSERT INTO memory_embedding_cache
          (provider, model, provider_key, hash, embedding, dims, updated_at)
         VALUES ('test', 'test', 'test', ?, ?, 2, 1)`,
        ).run(hash, encodeMemoryEmbedding([1, 0]));
        db.prepare(
          `INSERT INTO memory_index_chunk_provenance
          (chunk_id, origin_class, session_kind, observed_at)
         VALUES (?, ?, ?, 1)`,
        ).run(chunkId, file.originClass, file.sessionKind ?? "interactive");
      }
      db.exec("DROP TABLE IF EXISTS memory_session_tombstones");
      const revisionBefore = (
        db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get() as {
          revision: number;
        }
      ).revision;

      const preview = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        hookSources: ["gmail"],
        dryRun: true,
      });
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
      expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(memoryContent);
      expect(
        db
          .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
          .get("memory_session_tombstones"),
      ).toBeUndefined();
      expect(
        (
          db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get() as {
            revision: number;
          }
        ).revision,
      ).toBe(revisionBefore);

      if (failure !== "none") {
        const failureMessage = `synthetic ${failure} storage failure`;
        if (failure === "memory" || failure === "corpus") {
          const open = fs.open.bind(fs);
          const failedPath =
            failure === "memory" ? path.join(workspaceDir, "MEMORY.md") : mixedCorpusPath;
          const failedTempPrefix = `${failedPath}.forget.`;
          const fault = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const target = args[0];
            if (typeof target === "string" && target.startsWith(failedTempPrefix)) {
              throw new Error(failureMessage);
            }
            return await open(...args);
          });
          try {
            await expect(
              forgetMemoryEntries({ cfg, agentId: "main", hookSources: ["gmail"] }),
            ).rejects.toThrow(failureMessage);
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
            await expect(
              forgetMemoryEntries({ cfg, agentId: "main", hookSources: ["gmail"] }),
            ).rejects.toMatchObject(
              failure === "backup"
                ? { cause: { message: failureMessage } }
                : { message: failureMessage },
            );
          } finally {
            restore();
          }
        }
        expect(readMemoryForgetTombstonesForTest({ agentId: "main" })).toMatchObject([
          { sessionId: "target", reason: "forgotten" },
        ]);
      }
      const retryPreview = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        hookSources: ["gmail"],
        dryRun: true,
      });
      const observed =
        failure === "none" && corpusExtension === "txt" ? observePublishedSql(db) : undefined;
      const suppliedCalls: ReturnType<ReturnType<typeof observePublishedSql>["calls"]> = [];
      const isLineageRead = (sql: string) =>
        /\bSELECT\b[\s\S]*?\bFROM\s+["`]?memory_entry_origins\b/i.test(sql);
      const isPlanningRead = (sql: string) =>
        /\bSELECT\b[\s\S]*?\bFROM\s+["`]?memory_(?:index_(?:chunks|sources)|embedding_cache)\b/i.test(
          sql,
        );
      const isMutation = (sql: string) =>
        /\b(?:INSERT(?:\s+OR\s+\w+)?\s+INTO|UPDATE|DELETE\s+FROM)\s+["`]?memory_(?:entry_origins|session_tombstones|index_(?:state|chunks(?:_vec)?|sources)|embedding_cache)\b/i.test(
          sql,
        );
      let report: Awaited<ReturnType<typeof forgetMemoryEntries>>;
      try {
        if (observed) {
          expect(db.prepare("SELECT entry_key FROM memory_entry_origins WHERE 0").all()).toEqual(
            [],
          );
          expect(
            db.prepare("UPDATE memory_entry_origins SET observed_at = observed_at WHERE 0").run()
              .changes,
          ).toBe(0);
          expect(db.prepare("DELETE FROM memory_embedding_cache WHERE 0").run().changes).toBe(0);
          expect(db.prepare("SELECT id FROM memory_index_chunks WHERE 0").all()).toEqual([]);
          expect({
            lineage: observed.calls().filter(({ sql }) => isLineageRead(sql)).length,
            planning: observed.calls().filter(({ sql }) => isPlanningRead(sql)).length,
            mutations: observed.calls().filter(({ sql }) => isMutation(sql)).length,
          }).toEqual({ lineage: 1, planning: 1, mutations: 2 });
          observed.clear();
        }
        report = await forgetMemoryEntries({ cfg, agentId: "main", hookSources: ["gmail"] });
      } finally {
        if (observed) {
          try {
            suppliedCalls.push(...observed.calls());
          } finally {
            observed.restore();
          }
        }
      }
      expect(report).toEqual({ ...retryPreview, dryRun: false });
      const survivingMemory = await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8");
      expect(survivingMemory).toContain("Curated operator fact.");
      expect(survivingMemory).toContain("Keep the clean fact.");
      expect(survivingMemory).toContain("Preserve an untargetable legacy fact.");
      expect(survivingMemory).not.toContain("mixed secret");
      expect(survivingMemory).not.toContain("old-lineage");
      expect(await fs.readFile(lightDiaryPath, "utf8")).toBe(
        "# Light Dream\n- Candidate: Keep an unrelated memory.\n",
      );
      expect(await fs.readFile(rootDiaryPath, "utf8")).toBe("# Dream Diary\n");
      expect(await fs.readFile(path.join(workspaceDir, "USER.md"), "utf8")).toContain("Curated");
      expect(await fs.readFile(mixedCorpusPath, "utf8")).toBe(
        "[main/sessions/main/survivor#L1] keep\n",
      );
      await expect(fs.stat(removedCorpusPath)).rejects.toMatchObject({ code: "ENOENT" });
      for (const table of [
        "memory_index_chunks",
        "memory_index_chunks_fts",
        "memory_index_chunks_vec",
        "memory_index_chunk_provenance",
      ]) {
        expect(
          (db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
        ).toBe(1);
      }
      expect(
        (
          db.prepare("SELECT COUNT(*) AS count FROM memory_embedding_cache").get() as {
            count: number;
          }
        ).count,
      ).toBe(0);
      expect(
        (db.prepare("SELECT path FROM memory_index_sources").all() as Array<{ path: string }>).map(
          (row) => row.path,
        ),
      ).toEqual(["MEMORY.md", "sessions/main/survivor.jsonl.deleted.2026-08-25T10-00-00.000Z.zst"]);
      expect(
        db
          .prepare("SELECT id FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ?")
          .all("violet"),
      ).toEqual([]);
      expect(await fs.readFile(transcriptPath, "utf8")).toBe(
        "source transcript survives deletion\n",
      );
      expect(
        (
          db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get() as {
            revision: number;
          }
        ).revision,
      ).toBeGreaterThan(revisionBefore);
      expect(
        (
          await readMemoryCoreWorkspaceEntries({
            namespace: SHORT_TERM_RECALL_NAMESPACE,
            workspaceDir,
          })
        ).map((entry) => entry.key),
      ).toEqual(["clean-entry"]);
      expect(
        Object.keys((await readPhaseSignalStore(workspaceDir, new Date().toISOString())).entries),
      ).toEqual(["clean-entry"]);
      expect((await readSessionIngestionState(workspaceDir)).seenMessages).toEqual({
        "main:sessions/main/survivor": ["survivor-hash"],
      });
      const backups = await readMemoryCoreWorkspaceEntries<{
        content: string;
        contentHash: string;
      }>({ namespace: DREAMING_MEMORY_BACKUP_NAMESPACE, workspaceDir });
      expect(backups[0]?.value.content).not.toContain("mixed secret");
      expect(backups[0]?.value.content).not.toContain(sourceSnippet);
      expect(backups[0]?.value.contentHash).toBe(
        createHash("sha256").update(backups[0]!.value.content).digest("hex"),
      );
      expect(
        (await listMemoryEntryOrigins({ agentId: "main" })).map((origin) => origin.entryKey),
      ).toEqual(["clean-entry"]);
      const tombstones = readMemoryForgetTombstonesForTest({ agentId: "main" });
      expect(tombstones).toEqual([
        {
          agentId: "main",
          sessionId: "target",
          reason: "forgotten",
          createdAt: expect.any(Number),
        },
      ]);

      const repeated = await forgetMemoryEntries({ cfg, agentId: "main", hookSources: ["gmail"] });
      expect(repeated.sessionIds).toEqual(["target"]);
      expect(Object.values(repeated.artifacts).every((count) => count === 0)).toBe(true);
      expect(readMemoryForgetTombstonesForTest({ agentId: "main" })).toEqual(tombstones);
      if (observed) {
        expect({
          lineage: suppliedCalls.filter(({ sql }) => isLineageRead(sql)),
          planning: suppliedCalls.filter(({ sql }) => isPlanningRead(sql)),
          mutations: suppliedCalls.filter(({ sql }) => isMutation(sql)),
        }).toEqual({ lineage: [], planning: [], mutations: [] });
      }
    },
  );
});
