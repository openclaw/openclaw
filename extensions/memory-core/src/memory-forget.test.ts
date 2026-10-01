import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { deleteSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { appendSessionTranscriptMessageByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DREAMING_MEMORY_BACKUP_NAMESPACE,
  readMemoryCoreWorkspaceEntries,
  writeMemoryCoreWorkspaceEntries,
} from "./dreaming-state.js";
import {
  listMemoryEntryOrigins,
  listMemorySessionTombstones,
  recordMemoryEntryOrigins,
} from "./memory-entry-origins.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";
import { runSessionBackfill } from "./session-backfill.js";
import { readShortTermRecallEntries } from "./short-term-promotion.js";

vi.mock("openclaw/plugin-sdk/process-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/process-runtime")>();
  const { memoryForgetPlanningObserverEntrypoint } =
    await import("./memory-forget-planning-observer-entrypoint.test-support.js");
  return {
    ...actual,
    resolveRuntimeWorkerUrl(entry: Parameters<typeof actual.resolveRuntimeWorkerUrl>[0]) {
      return actual.resolveRuntimeWorkerUrl(
        entry.sourceWorkerName === "manager-search.worker"
          ? memoryForgetPlanningObserverEntrypoint
          : entry,
      );
    },
  };
});

describe("memory forget", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  let workspaceDir: string;
  let cfg: OpenClawConfig;

  beforeEach(async () => {
    fixture = await createMemoryForgetFixture();
    ({ workspaceDir, cfg } = fixture);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it("previews an unresolved session without creating the absent agent store", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    const report = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["missing"],
      dryRun: true,
    });
    expect(report).toEqual({
      agentId: "main",
      dryRun: true,
      sessionIds: ["missing"],
      participantMatches: [],
      sessionResolutions: [{ sessionId: "missing", source: "unresolved" }],
      entryKeys: [],
      mixedLineageEntryKeys: [],
      untargetableEntryKeys: [],
      curatedWrites: [],
      artifacts: {
        memoryFiles: 0,
        memoryEntries: 0,
        memoryLines: 0,
        sessionCorpusFiles: 0,
        sessionCorpusLines: 0,
        indexChunks: 0,
        indexSources: 0,
        ftsRows: 0,
        vectorRows: 0,
        embeddingCacheRows: 0,
        shortTermEntries: 0,
        seenHashScopes: 0,
        backups: 0,
        originRows: 0,
      },
      refusals: [],
    });
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${databasePath}-wal`)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(`${databasePath}-shm`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews and forgets sessions without fetching unrelated session bodies", async () => {
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const insert = db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES (?, ?, ?, 1, 1, 'fixture-hash', 'test', ?, x'', 1)`);
    const provenance = db.prepare(`INSERT INTO memory_index_chunk_provenance
      (chunk_id, origin_class, session_kind, observed_at) VALUES (?, 'agent', 'interactive', 1)`);
    const body = "unrelated session body 🚀\0".repeat(4_096);
    for (let index = 0; index < 32; index += 1) {
      const id = `session-${index}`;
      insert.run(id, `sessions/main/${index === 0 ? "target" : id}.jsonl`, "sessions", body);
      provenance.run(id);
    }
    insert.run(
      "memory-target",
      "memory/target.md",
      "memory",
      "## Session ID: target\nForget this.",
    );
    insert.run("memory-keep", "MEMORY.md", "memory", "Keep this memory.\0🚀");
    // Six slots: all/iterate calibration, rows, UTF-8 bytes, tasks, completed replies.
    const counters = new Int32Array(new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT));
    const runtime = await import("./memory/manager-cpu-worker-runtime.js");
    const plan = runtime.runMemoryForgetIndexPlan;
    const dispatch = vi.spyOn(runtime, "runMemoryForgetIndexPlan").mockImplementation((request) => {
      const observedRequest = { ...request, forgetReadObservation: counters.buffer };
      return plan(observedRequest);
    });
    const allSpy = vi.spyOn(StatementSync.prototype, "all");
    const iterateSpy = vi.spyOn(StatementSync.prototype, "iterate");
    const hostPlannerReads = () =>
      [...allSpy.mock.contexts, ...iterateSpy.mock.contexts].filter(
        (statement) =>
          statement instanceof StatementSync &&
          statement.sourceSQL.includes('left join "memory_index_chunk_provenance"'),
      ).length;
    try {
      // Warm the worker, then measure only preview and apply.
      for (let pass = 0; pass < 2; pass++) {
        await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"], dryRun: true });
      }
      expect([Atomics.load(counters, 0), Atomics.load(counters, 1)]).toEqual([1, 1]);
      const calibration = db.prepare(
        'select chunk.id from memory_index_chunks as chunk left join "memory_index_chunk_provenance" as provenance on provenance.chunk_id = chunk.id where 0',
      );
      allSpy.mockClear();
      iterateSpy.mockClear();
      expect(calibration.all()).toEqual([]);
      expect([...calibration.iterate()]).toEqual([]);
      expect(hostPlannerReads()).toBe(2);
      allSpy.mockClear();
      iterateSpy.mockClear();
      for (let slot = 2; slot < counters.length; slot++) {
        Atomics.store(counters, slot, 0);
      }
      const preview = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        sessionIds: ["target"],
        dryRun: true,
      });
      expect(preview.artifacts.indexChunks).toBe(2);
      expect(db.prepare("SELECT count(*) AS count FROM memory_index_chunks").get()).toEqual({
        count: 34,
      });
      const result = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
      expect(result).toEqual({ ...preview, dryRun: false });
      expect(db.prepare("SELECT id FROM memory_index_chunks ORDER BY id").all()).toEqual(
        ["memory-keep", ...Array.from({ length: 31 }, (_, index) => `session-${index + 1}`)]
          .toSorted()
          .map((id) => ({ id })),
      );
      expect(
        db.prepare("SELECT text FROM memory_index_chunks WHERE id = 'session-1'").get(),
      ).toEqual({ text: body });
      const fetchedRows = Atomics.load(counters, 2);
      const fetchedBytes = Atomics.load(counters, 3);
      expect(fetchedRows).toBe(68);
      expect(fetchedBytes).toBeLessThan(16_384);
      expect([Atomics.load(counters, 4), Atomics.load(counters, 5)]).toEqual([2, 2]);
      expect(hostPlannerReads()).toBe(0);
    } finally {
      allSpy.mockRestore();
      iterateSpy.mockRestore();
      dispatch.mockRestore();
    }
  });

  it.each([true, false])(
    "reports no cache deletion for an empty selection (dryRun=%s)",
    async (dryRun) => {
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      db.prepare(`INSERT INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES ('test', 'test', 'test', 'unrelated', ?, 2, 1)`).run(encodeMemoryEmbedding([1, 0]));
      const report = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        hookSources: ["no-matching-source"],
        dryRun,
      });
      expect(report.sessionIds).toEqual([]);
      expect(report.artifacts.embeddingCacheRows).toBe(0);
      expect(db.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([
        { hash: "unrelated" },
      ]);
    },
  );

  it.each([
    { label: "session ID", selector: "archived" },
    { label: "session key", selector: "agent:main:archived" },
  ])("purges an archived-only session selected by its $label", async ({ selector }) => {
    await seedMemoryForgetSession("archived");
    await recordMemoryEntryOrigins({
      agentId: "main",
      origins: [
        {
          entryKey: "archived-entry",
          agentId: "main",
          sessionId: "archived",
          sessionKey: "agent:main:archived",
          originClass: "owner",
          observedAt: 1_000,
        },
      ],
    });
    await fs.writeFile(
      path.join(workspaceDir, "MEMORY.md"),
      "# Long-Term Memory\n<!-- openclaw-memory-promotion:archived-entry -->\n- Archived secret.\n",
    );
    await fs.writeFile(path.join(workspaceDir, "USER.md"), "# User\nKeep curated profile.\n");
    const corpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(
      path.join(corpusDir, "archived.txt"),
      "[main/sessions/main/archived#L1] User: An archived private fact.\n",
    );
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: "archived",
      sessionKey: "agent:main:archived",
      message: {
        role: "assistant",
        timestamp: 2_000,
        content: [
          { type: "toolCall", id: "curated", name: "write", arguments: { path: "USER.md" } },
        ],
      },
    });
    await expect(
      deleteSessionEntry({
        agentId: "main",
        sessionKey: "agent:main:archived",
        expectedSessionId: "archived",
        archiveTranscript: true,
      }),
    ).resolves.toBe(true);
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    expect(
      db.prepare("SELECT session_id FROM session_windows WHERE session_id = ?").get("archived"),
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT session_id, session_key FROM session_transcript_archives WHERE session_id = ?",
        )
        .get("archived"),
    ).toEqual({ session_id: "archived", session_key: "agent:main:archived" });

    const preview = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: [selector],
      dryRun: true,
    });
    expect(preview).toMatchObject({
      sessionIds: ["archived"],
      sessionResolutions: [
        { sessionId: "archived", sessionKey: "agent:main:archived", source: "archived" },
      ],
      entryKeys: ["archived-entry"],
      curatedWrites: [{ relativePath: "USER.md", observedAt: expect.any(Number) }],
      artifacts: { memoryEntries: 1, sessionCorpusLines: 1, originRows: 1 },
    });
    expect(await listMemorySessionTombstones({ agentId: "main" })).toEqual([]);

    const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: [selector] });
    expect(report).toEqual({ ...preview, dryRun: false });
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).not.toContain(
      "Archived secret",
    );
    expect(await fs.readFile(path.join(workspaceDir, "USER.md"), "utf8")).toContain(
      "Keep curated profile",
    );
    expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
    expect(await listMemorySessionTombstones({ agentId: "main" })).toMatchObject([
      { sessionId: "archived", reason: "forgotten" },
    ]);
  });

  it("leaves the original memory file intact when a rewrite fails mid-write", async () => {
    await seedMemoryForgetSession("archived");
    await recordMemoryEntryOrigins({
      agentId: "main",
      origins: [
        {
          entryKey: "archived-entry",
          agentId: "main",
          sessionId: "archived",
          sessionKey: "agent:main:archived",
          originClass: "owner",
          observedAt: 1_000,
        },
      ],
    });
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    const originalContent =
      "# Long-Term Memory\n" +
      "Curated operator fact that must survive.\n" +
      "<!-- openclaw-memory-promotion:archived-entry -->\n" +
      "- Archived secret.\n";
    await fs.writeFile(memoryPath, originalContent);
    await deleteSessionEntry({
      agentId: "main",
      sessionKey: "agent:main:archived",
      expectedSessionId: "archived",
      archiveTranscript: true,
    });

    // Exercise both the old direct write and the replacement temp write so this
    // regression fails against the original boundary for the observed data loss.
    const writeFile = fs.writeFile.bind(fs);
    const directWriteFault = vi.spyOn(fs, "writeFile").mockImplementation(async (...args) => {
      if (args[0] === memoryPath) {
        await writeFile(memoryPath, "Curated ope");
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
      return await writeFile(...args);
    });
    const open = fs.open.bind(fs);
    const tempPrefix = `${memoryPath}.forget.`;
    const fault = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const target = args[0];
      if (typeof target === "string" && target.startsWith(tempPrefix)) {
        const handle = await open(...args);
        await handle.writeFile("Curated ope");
        await handle.close();
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
      return await open(...args);
    });
    try {
      await expect(
        forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["archived"] }),
      ).rejects.toMatchObject({ code: "ENOSPC" });
    } finally {
      fault.mockRestore();
      directWriteFault.mockRestore();
    }
    expect(await fs.readFile(memoryPath, "utf8")).toBe(originalContent);

    // A retry with the fault cleared still completes the purge.
    const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["archived"] });
    expect(report.entryKeys).toEqual(["archived-entry"]);
    expect(await fs.readFile(memoryPath, "utf8")).not.toContain("Archived secret");
  });

  it("durably tombstones an unresolved explicit session without changing mixed-newline artifacts", async () => {
    const content = "# Long-Term Memory\r\nKeep this.\n";
    const memoryPath = path.join(workspaceDir, "MEMORY.md");
    await fs.writeFile(memoryPath, content);
    const backup = {
      key: "unrelated-backup",
      value: {
        createdAt: "2026-08-25T00:00:00.000Z",
        content,
        contentHash: createHash("sha256").update(content).digest("hex"),
      },
    };
    await writeMemoryCoreWorkspaceEntries({
      namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
      workspaceDir,
      entries: [backup],
    });
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.prepare(
      `INSERT INTO memory_index_chunks
        (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES ('unrelated', 'MEMORY.md', 'memory', 1, 2,
         'unrelated-hash', 'test', 'Keep this.', ?, 1)`,
    ).run(encodeMemoryEmbedding([1, 0]));
    db.prepare(
      `INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES ('test', 'test', 'test', 'unrelated-hash', ?, 2, 1)`,
    ).run(encodeMemoryEmbedding([1, 0]));

    const preview = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["unknown-session"],
      dryRun: true,
    });
    expect(preview).toMatchObject({
      sessionIds: ["unknown-session"],
      sessionResolutions: [{ sessionId: "unknown-session", source: "unresolved" }],
      artifacts: { embeddingCacheRows: 1 },
    });
    expect(
      Object.entries(preview.artifacts)
        .filter(([name]) => name !== "embeddingCacheRows")
        .every(([, count]) => count === 0),
    ).toBe(true);
    expect(await listMemorySessionTombstones({ agentId: "main" })).toEqual([]);

    const report = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["unknown-session"],
    });
    expect(report).toEqual({ ...preview, dryRun: false });
    const tombstones = await listMemorySessionTombstones({ agentId: "main" });
    expect(tombstones).toMatchObject([{ sessionId: "unknown-session", reason: "forgotten" }]);
    expect(
      await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["unknown-session"] }),
    ).toEqual({
      ...report,
      artifacts: { ...report.artifacts, embeddingCacheRows: 0 },
    });
    expect(await listMemorySessionTombstones({ agentId: "main" })).toEqual(tombstones);
    expect(await fs.readFile(memoryPath, "utf8")).toBe(content);
    expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual([{ id: "unrelated" }]);
    expect(db.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([]);
    expect(
      await readMemoryCoreWorkspaceEntries({
        namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
        workspaceDir,
      }),
    ).toEqual([backup]);
  });

  it.each([
    { label: "LF", targetEnding: "\n", survivorEnding: "\n" },
    { label: "CRLF", targetEnding: "\r\n", survivorEnding: "\r\n" },
    { label: "mixed", targetEnding: "\r\n", survivorEnding: "\n" },
  ])(
    "preserves surviving line endings when purging $label corpus, memory, and backups",
    async ({ targetEnding, survivorEnding }) => {
      const memoryPath = path.join(workspaceDir, "MEMORY.md");
      const corpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
      const corpusPath = path.join(corpusDir, "2026-08-26.txt");
      const quotation = "User: Remove this selected private fact.";
      const retainedMemory = "# Long-Term Memory\r\nKeep this.\nAnother retained line.\r\n";
      const content = `${retainedMemory}- Candidate: ${quotation}\r\n`;
      const retainedCorpus = `[main/sessions/main/survivor#L1] User: Keep this unrelated fact.${survivorEnding}`;
      await fs.mkdir(corpusDir, { recursive: true });
      await fs.writeFile(memoryPath, content);
      await fs.writeFile(
        corpusPath,
        `[main/sessions/main/target#L1] ${quotation}${targetEnding}${retainedCorpus}`,
      );
      await writeMemoryCoreWorkspaceEntries({
        namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
        workspaceDir,
        entries: [
          {
            key: "backup",
            value: {
              createdAt: "2026-08-25T00:00:00.000Z",
              content,
              contentHash: createHash("sha256").update(content).digest("hex"),
            },
          },
        ],
      });

      const preview = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        sessionIds: ["target"],
        dryRun: true,
      });
      expect(preview.artifacts).toMatchObject({
        memoryFiles: 1,
        memoryLines: 1,
        sessionCorpusFiles: 1,
        sessionCorpusLines: 1,
        backups: 1,
      });
      expect(await fs.readFile(memoryPath, "utf8")).toBe(content);
      const report = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
      expect(report).toEqual({ ...preview, dryRun: false });
      expect(await fs.readFile(memoryPath, "utf8")).toBe(retainedMemory);
      expect(await fs.readFile(corpusPath, "utf8")).toBe(retainedCorpus);
      expect(
        await readMemoryCoreWorkspaceEntries({
          namespace: DREAMING_MEMORY_BACKUP_NAMESPACE,
          workspaceDir,
        }),
      ).toEqual([
        {
          key: "backup",
          value: {
            createdAt: "2026-08-25T00:00:00.000Z",
            content: retainedMemory,
            contentHash: createHash("sha256").update(retainedMemory).digest("hex"),
          },
        },
      ]);
    },
  );

  it("removes staged backfill entries when their source session is forgotten", async () => {
    await seedMemoryForgetSession("backfilled");
    const nowMs = Date.parse("2026-08-26T12:00:00.000Z");
    const privateFact = "The project launch code is amber-indigo.";
    await appendSessionTranscriptMessageByIdentity({
      agentId: "main",
      sessionId: "backfilled",
      sessionKey: "agent:main:backfilled",
      message: {
        role: "user",
        content: privateFact,
        timestamp: nowMs,
        __openclaw: { senderIsOwner: true },
      },
    });
    const applied = await runSessionBackfill({
      agentId: "main",
      workspaceDir,
      apply: true,
      nowMs,
      timezone: "UTC",
    });
    expect(applied.stagedEntries).toBe(1);
    const report = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["backfilled"],
    });
    const remaining = await readShortTermRecallEntries({ workspaceDir, nowMs });
    expect(report.artifacts.shortTermEntries).toBe(1);
    expect(remaining.map((entry) => entry.snippet)).not.toContain(privateFact);
  });

  it.each(["prefix-survivor", "prefix.jsonl.other", "PREFIX"])(
    "does not purge session %s when an unresolved explicit selector is prefix",
    async (survivorId) => {
      await seedMemoryForgetSession(survivorId);
      const corpusDir = path.join(workspaceDir, "memory", ".dreams", "session-corpus");
      await fs.mkdir(corpusDir, { recursive: true });
      const corpusPath = path.join(corpusDir, "2026-08-26.txt");
      const content = `[main/sessions/main/${survivorId}#L1] User: Preserve this unrelated fact.\n`;
      await fs.writeFile(corpusPath, content);
      const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
      db.prepare(
        `INSERT INTO memory_index_chunks
        (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
       VALUES ('survivor-chunk', ?, 'sessions', 1, 1,
         'survivor-hash', 'test', 'Preserve this unrelated fact.', ?, 1)`,
      ).run(`sessions/main/${survivorId}.jsonl`, encodeMemoryEmbedding([1, 0]));
      db.prepare(
        `INSERT INTO memory_index_chunk_provenance
        (chunk_id, origin_class, session_kind, observed_at)
       VALUES ('survivor-chunk', 'owner', 'interactive', 1)`,
      ).run();
      const report = await forgetMemoryEntries({
        cfg,
        agentId: "main",
        sessionIds: ["prefix"],
      });
      const remainingContent = await fs.readFile(corpusPath, "utf8").catch(() => "missing");
      const remainingChunks = db.prepare("SELECT id FROM memory_index_chunks").all();
      expect(report.sessionResolutions).toEqual([{ sessionId: "prefix", source: "unresolved" }]);
      expect(remainingContent).toBe(content);
      expect(remainingChunks).toEqual([{ id: "survivor-chunk" }]);
    },
  );

  it("keeps missing provenance untargetable without creating its table during dry-run", async () => {
    await seedMemoryForgetSession("target");
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    db.exec("DROP TABLE IF EXISTS memory_entry_origins");
    db.exec("DROP TABLE IF EXISTS memory_session_tombstones");
    const memoryContent =
      "# Long-Term Memory\n<!-- openclaw-memory-promotion:legacy-entry -->\n- Keep old memory.\n";
    await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), memoryContent);
    const revision = (
      db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get() as {
        revision: number;
      }
    ).revision;

    const report = await forgetMemoryEntries({
      cfg,
      agentId: "main",
      sessionIds: ["target"],
      dryRun: true,
    });

    expect(report.entryKeys).toEqual([]);
    expect(report.untargetableEntryKeys).toEqual(["legacy-entry"]);
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(memoryContent);
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("memory_entry_origins"),
    ).toBeUndefined();
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
    ).toBe(revision);

    const deleted = await forgetMemoryEntries({ cfg, agentId: "main", sessionIds: ["target"] });
    expect(deleted.artifacts.memoryFiles).toBe(0);
    expect(await fs.readFile(path.join(workspaceDir, "MEMORY.md"), "utf8")).toBe(memoryContent);
    expect(await listMemorySessionTombstones({ agentId: "main" })).toMatchObject([
      { agentId: "main", sessionId: "target", reason: "forgotten" },
    ]);
    expect(
      db
        .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get("memory_entry_origins"),
    ).toBeUndefined();
  });
});
