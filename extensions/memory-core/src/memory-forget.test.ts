import fs from "node:fs/promises";
import path from "node:path";
import { StatementSync } from "node:sqlite";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import {
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { describe, expect, it, vi } from "vitest";
import { DREAMING_MEMORY_BACKUP_NAMESPACE } from "./dreaming-state.js";
import {
  memoryForgetHarness,
  memoryOrigin,
  memoryBackup as backup,
  memoryIndexFixture,
} from "./memory-forget.suite.test-support.js";
import { seedMemoryForgetSession } from "./memory-forget.test-helpers.js";
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
  const h = memoryForgetHarness();
  const { origins, tombstones, readText } = h;
  const forget = (sessionId: string, dryRun = false) =>
    h.forget({ sessionIds: [sessionId], dryRun });

  const archivedOrigin = memoryOrigin("archived-entry", "archived");

  it("previews an unresolved session without creating the absent agent store", async () => {
    const databasePath = resolveOpenClawAgentSqlitePath({ agentId: "main" });
    await expect(fs.stat(databasePath)).rejects.toMatchObject({ code: "ENOENT" });
    const { artifacts, ...report } = await forget("missing", true);
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
      refusals: [],
    });
    expect(Object.values(artifacts).every((count) => count === 0)).toBe(true);
    for (const suffix of ["", "-wal", "-shm"]) {
      await expect(fs.stat(`${databasePath}${suffix}`)).rejects.toMatchObject({ code: "ENOENT" });
    }
  });

  it("previews and forgets sessions without fetching unrelated session bodies", async () => {
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const indexData = memoryIndexFixture(db);
    const body = "unrelated session body 🚀\0".repeat(4_096);
    for (let index = 0; index < 32; index += 1) {
      const id = `session-${index}`;
      indexData.chunk(id, `sessions/main/${index === 0 ? "target" : id}.jsonl`, { text: body });
      indexData.provenance(id);
    }
    indexData.chunk("memory-target", "memory/target.md", {
      source: "memory",
      text: "## Session ID: target\nForget this.",
    });
    indexData.chunk("memory-keep", "MEMORY.md", {
      source: "memory",
      text: "Keep this memory.\0🚀",
    });
    // Six slots: all/iterate calibration, rows, UTF-8 bytes, tasks, completed replies.
    const counters = new Int32Array(new SharedArrayBuffer(6 * Int32Array.BYTES_PER_ELEMENT));
    const runtime = await import("./memory/manager-cpu-worker-runtime.js");
    const plan = runtime.runMemoryForgetIndexPlan;
    const dispatch = vi.spyOn(runtime, "runMemoryForgetIndexPlan").mockImplementation((request) => {
      const observedRequest = { ...request, forgetReadObservation: counters.buffer };
      return plan(observedRequest);
    });
    let hostPlannerReads = 0;
    const readSpies = (["all", "iterate"] as const).map((method) => {
      const original = StatementSync.prototype[method];
      return vi.spyOn(StatementSync.prototype, method).mockImplementation(
        new Proxy(original, {
          apply(target, statement: StatementSync, args) {
            if (statement.sourceSQL.includes('left join "memory_index_chunk_provenance"')) {
              hostPlannerReads++;
            }
            return Reflect.apply(target, statement, args);
          },
        }),
      );
    });
    try {
      // Warm the worker, then measure only preview and apply.
      for (let pass = 0; pass < 2; pass++) {
        await forget("target", true);
      }
      expect([Atomics.load(counters, 0), Atomics.load(counters, 1)]).toEqual([1, 1]);
      const calibration = db.prepare(
        'select chunk.id from memory_index_chunks as chunk left join "memory_index_chunk_provenance" as provenance on provenance.chunk_id = chunk.id where 0',
      );
      hostPlannerReads = 0;
      expect(calibration.all()).toEqual([]);
      expect([...calibration.iterate()]).toEqual([]);
      expect(hostPlannerReads).toBe(2);
      hostPlannerReads = 0;
      for (let slot = 2; slot < counters.length; slot++) {
        Atomics.store(counters, slot, 0);
      }
      const preview = await forget("target", true);
      expect(preview.artifacts.indexChunks).toBe(2);
      expect(db.prepare("SELECT count(*) AS count FROM memory_index_chunks").get()).toEqual({
        count: 34,
      });
      const result = await forget("target");
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
      expect(hostPlannerReads).toBe(0);
    } finally {
      readSpies.forEach((spy) => spy.mockRestore());
      dispatch.mockRestore();
    }
  });

  it("purges an archived-only session selected by its session ID", async () => {
    const selector = "archived";
    await seedMemoryForgetSession("archived");
    await h.recordOrigins([archivedOrigin]);
    await h.write(
      "MEMORY.md",
      "# Long-Term Memory\n<!-- openclaw-memory-promotion:archived-entry -->\n- Archived secret.\n",
    );
    await h.write("USER.md", "# User\nKeep curated profile.\n");
    const corpusDir = h.path("memory", ".dreams", "session-corpus");
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(
      path.join(corpusDir, "archived.txt"),
      "[main/sessions/main/archived#L1] User: An archived private fact.\n",
    );
    await h.append("archived", {
      role: "assistant",
      timestamp: 2_000,
      content: [{ type: "toolCall", id: "curated", name: "write", arguments: { path: "USER.md" } }],
    });
    await expect(h.archive("archived")).resolves.toBe(true);
    const preview = await forget(selector, true);
    expect(preview).toMatchObject({
      sessionIds: ["archived"],
      sessionResolutions: [
        { sessionId: "archived", sessionKey: "agent:main:archived", source: "archived" },
      ],
      entryKeys: ["archived-entry"],
      curatedWrites: [{ relativePath: "USER.md", observedAt: expect.any(Number) }],
      artifacts: { memoryEntries: 1, sessionCorpusLines: 1, originRows: 1 },
    });
    expect(tombstones()).toEqual([]);

    const report = await forget(selector);
    expect(report).toEqual({ ...preview, dryRun: false });
    expect(await h.read("MEMORY.md")).not.toContain("Archived secret");
    expect(await h.read("USER.md")).toContain("Keep curated profile");
    expect(await origins()).toEqual([]);
    expect(tombstones()).toMatchObject([{ sessionId: "archived", reason: "forgotten" }]);
  });

  it("leaves the original memory file intact when a rewrite fails mid-write", async () => {
    await seedMemoryForgetSession("archived");
    await h.recordOrigins([archivedOrigin]);
    const memoryPath = h.path("MEMORY.md");
    const originalContent =
      "# Long-Term Memory\n" +
      "Curated operator fact that must survive.\n" +
      "<!-- openclaw-memory-promotion:archived-entry -->\n" +
      "- Archived secret.\n";
    await fs.writeFile(memoryPath, originalContent);
    await h.archive("archived");

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
      await expect(forget("archived")).rejects.toMatchObject({ code: "ENOSPC" });
    } finally {
      fault.mockRestore();
      directWriteFault.mockRestore();
    }
    expect(await readText(memoryPath)).toBe(originalContent);

    // A retry with the fault cleared still completes the purge.
    const report = await forget("archived");
    expect(report.entryKeys).toEqual(["archived-entry"]);
    expect(await readText(memoryPath)).not.toContain("Archived secret");
  });

  it("durably tombstones an unresolved explicit session without changing mixed-newline artifacts", async () => {
    const content = "# Long-Term Memory\r\nKeep this.\n";
    const memoryPath = h.path("MEMORY.md");
    await fs.writeFile(memoryPath, content);
    const savedBackup = backup(content, "unrelated-backup");
    await h.writeEntries(DREAMING_MEMORY_BACKUP_NAMESPACE, [savedBackup]);
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    memoryIndexFixture(db).chunk("unrelated", "MEMORY.md", {
      source: "memory",
      text: "Keep this.",
      hash: "unrelated-hash",
      endLine: 2,
      embedding: encodeMemoryEmbedding([1, 0]),
    });
    db.prepare(
      `INSERT INTO memory_embedding_cache
        (provider, model, provider_key, hash, embedding, dims, updated_at)
       VALUES ('test', 'test', 'test', 'unrelated-hash', ?, 2, 1)`,
    ).run(encodeMemoryEmbedding([1, 0]));

    const preview = await forget("unknown-session", true);
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
    expect(tombstones()).toEqual([]);

    const report = await forget("unknown-session");
    expect(report).toEqual({ ...preview, dryRun: false });
    const savedTombstones = tombstones();
    expect(savedTombstones).toMatchObject([{ sessionId: "unknown-session", reason: "forgotten" }]);
    expect(await forget("unknown-session")).toEqual({
      ...report,
      artifacts: { ...report.artifacts, embeddingCacheRows: 0 },
    });
    expect(tombstones()).toEqual(savedTombstones);
    expect(await readText(memoryPath)).toBe(content);
    expect(db.prepare("SELECT id FROM memory_index_chunks").all()).toEqual([{ id: "unrelated" }]);
    expect(db.prepare("SELECT hash FROM memory_embedding_cache").all()).toEqual([]);
    expect(await h.readEntries(DREAMING_MEMORY_BACKUP_NAMESPACE)).toEqual([savedBackup]);
  });

  it("preserves mixed line endings when purging corpus, memory, and backups", async () => {
    const memoryPath = h.path("MEMORY.md");
    const corpusDir = h.path("memory", ".dreams", "session-corpus");
    const corpusPath = path.join(corpusDir, "2026-08-26.txt");
    const quotation = "User: Remove this selected private fact.";
    const retainedMemory = "# Long-Term Memory\r\nKeep this.\nAnother retained line.\r\n";
    const content = `${retainedMemory}- Candidate: ${quotation}\r\n`;
    const retainedCorpus = "[main/sessions/main/survivor#L1] User: Keep this unrelated fact.\n";
    await fs.mkdir(corpusDir, { recursive: true });
    await fs.writeFile(memoryPath, content);
    await fs.writeFile(
      corpusPath,
      `[main/sessions/main/target#L1] ${quotation}\r\n${retainedCorpus}`,
    );
    await h.writeEntries(DREAMING_MEMORY_BACKUP_NAMESPACE, [backup(content)]);

    const preview = await forget("target", true);
    expect(preview.artifacts).toMatchObject({
      memoryFiles: 1,
      memoryLines: 1,
      sessionCorpusFiles: 1,
      sessionCorpusLines: 1,
      backups: 1,
    });
    expect(await readText(memoryPath)).toBe(content);
    const report = await forget("target");
    expect(report).toEqual({ ...preview, dryRun: false });
    expect(await readText(memoryPath)).toBe(retainedMemory);
    expect(await readText(corpusPath)).toBe(retainedCorpus);
    expect(await h.readEntries(DREAMING_MEMORY_BACKUP_NAMESPACE)).toEqual([backup(retainedMemory)]);
  });

  it("removes staged backfill entries when their source session is forgotten", async () => {
    await seedMemoryForgetSession("backfilled");
    const nowMs = Date.parse("2026-08-26T12:00:00.000Z");
    const privateFact = "The project launch code is amber-indigo.";
    await h.append("backfilled", {
      role: "user",
      content: privateFact,
      timestamp: nowMs,
      __openclaw: { senderIsOwner: true },
    });
    const applied = await runSessionBackfill({
      agentId: "main",
      workspaceDir: h.workspaceDir,
      apply: true,
      nowMs,
      timezone: "UTC",
    });
    expect(applied.stagedEntries).toBe(1);
    const report = await forget("backfilled");
    const remaining = await readShortTermRecallEntries({ workspaceDir: h.workspaceDir, nowMs });
    expect(report.artifacts.shortTermEntries).toBe(1);
    expect(remaining.map((entry) => entry.snippet)).not.toContain(privateFact);
  });

  it("does not purge a dotted-suffix session when an unresolved selector is its prefix", async () => {
    const survivorId = "prefix.jsonl.other";
    await seedMemoryForgetSession(survivorId);
    const corpusDir = h.path("memory", ".dreams", "session-corpus");
    await fs.mkdir(corpusDir, { recursive: true });
    const corpusPath = path.join(corpusDir, "2026-08-26.txt");
    const content = `[main/sessions/main/${survivorId}#L1] User: Preserve this unrelated fact.\n`;
    await fs.writeFile(corpusPath, content);
    const db = openOpenClawAgentDatabase({ agentId: "main" }).db;
    const indexData = memoryIndexFixture(db);
    indexData.chunk("survivor-chunk", `sessions/main/${survivorId}.jsonl`, {
      text: "Preserve this unrelated fact.",
      hash: "survivor-hash",
      embedding: encodeMemoryEmbedding([1, 0]),
    });
    indexData.provenance("survivor-chunk", "owner");
    const report = await forget("prefix");
    const remainingContent = await readText(corpusPath).catch(() => "missing");
    const remainingChunks = db.prepare("SELECT id FROM memory_index_chunks").all();
    expect(report.sessionResolutions).toEqual([{ sessionId: "prefix", source: "unresolved" }]);
    expect(remainingContent).toBe(content);
    expect(remainingChunks).toEqual([{ id: "survivor-chunk" }]);
  });
});
