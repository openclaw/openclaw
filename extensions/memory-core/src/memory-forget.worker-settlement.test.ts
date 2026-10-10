import fs from "node:fs/promises";
import path from "node:path";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listMemoryEntryOrigins, recordMemoryEntryOrigins } from "./memory-entry-origins.js";
import { observeMemoryForgetWorker } from "./memory-forget-fault.test-support.js";
import { forgetMemoryEntries } from "./memory-forget.js";
import {
  createMemoryForgetFixture,
  seedMemoryForgetSession,
} from "./memory-forget.test-helpers.js";
import { memoryCpuProcessEntrypoints } from "./memory/manager-cpu-entrypoints.js";
import { readMemoryForgetTombstonesForTest } from "./test-helpers.js";

describe("memory forget worker settlement", () => {
  let fixture: Awaited<ReturnType<typeof createMemoryForgetFixture>>;
  beforeEach(async () => {
    fixture = await createMemoryForgetFixture("memory-forget-settlement-");
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await fixture.cleanup();
  });

  async function seedSelectedMemory(withOrigins: boolean) {
    await seedMemoryForgetSession("target");
    const { db } = sqliteRuntime.openOpenClawAgentDatabase({ agentId: "main" });
    if (withOrigins) {
      await recordMemoryEntryOrigins({
        agentId: "main",
        origins: [
          {
            entryKey: "selected-entry",
            agentId: "main",
            sessionId: "target",
            sessionKey: "agent:main:target",
            originClass: "owner",
            observedAt: 1_000,
          },
        ],
      });
    } else {
      db.exec("DROP TABLE IF EXISTS memory_entry_origins");
    }
    db.exec("DROP TABLE IF EXISTS memory_session_tombstones");
    const memoryPath = path.join(fixture.workspaceDir, "MEMORY.md");
    const retained = "# Memory\nKeep the unrelated amber fact.\n";
    const selected = withOrigins
      ? "<!-- openclaw-memory-promotion:selected-entry -->\n- Private violet fact.\n"
      : "## Session ID: target\n- Private violet fact.\n";
    const content = retained + selected;
    await fs.writeFile(memoryPath, content);
    db.prepare(`INSERT INTO memory_index_sources (path, source, hash, mtime, size)
      VALUES ('sessions/main/target.jsonl', 'sessions', 'selected', 1, 1)`).run();
    db.prepare(`INSERT INTO memory_index_chunks
      (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at)
      VALUES ('selected-chunk', 'sessions/main/target.jsonl', 'sessions', 1, 1,
        'selected', 'fixture', 'Private violet fact.', x'', 1)`).run();
    db.prepare(`INSERT INTO memory_embedding_cache
      (provider, model, provider_key, hash, embedding, dims, updated_at)
      VALUES ('fixture', 'fixture', 'fixture', 'selected', ?, 1, 1)`).run(
      encodeMemoryEmbedding([1]),
    );
    const derived = () => ({
      chunks: db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all(),
      sources: db.prepare("SELECT * FROM memory_index_sources ORDER BY id").all(),
      cache: db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all(),
    });
    const optionalTables = () =>
      db
        .prepare(`SELECT name FROM sqlite_schema
      WHERE name IN ('memory_entry_origins', 'memory_session_tombstones') ORDER BY name`)
        .all();
    const revision = () => db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get();
    return {
      db,
      memoryPath,
      content,
      retained,
      derived,
      optionalTables,
      revision,
      params: { cfg: fixture.cfg, agentId: "main", sessionIds: ["target"] },
    };
  }

  it.each(["forget.mark", "forget.purge"] as const)(
    "stops after the real %s commit loses its result and completes only on explicit retry",
    async (failResult) => {
      const state = await seedSelectedMemory(true);
      const before = state.derived();
      const origins = await listMemoryEntryOrigins({ agentId: "main" });
      const reportPath = path.join(fixture.stateDir, "forget-native-report.jsonl");
      const restore = observeMemoryForgetWorker(state.db, { failResult, reportPath });
      try {
        const delivered = await forgetMemoryEntries(state.params).then(
          (report) => ({ status: "resolved" as const, report }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
        expect(delivered).toMatchObject({
          status: "rejected",
          error: {
            message: expect.stringContaining(`injected committed ${failResult} reply failure`),
          },
        });
        const nativeReports = (await fs.readFile(reportPath, "utf8"))
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line));
        expect(nativeReports).toEqual([
          { tombstoneInserts: 1, sourceDeletes: failResult === "forget.purge" ? 1 : 0 },
        ]);
        const tombstones = readMemoryForgetTombstonesForTest({ agentId: "main" });
        expect(tombstones).toEqual([
          {
            sessionId: "target",
            agentId: "main",
            reason: "forgotten",
            createdAt: expect.any(Number),
          },
        ]);
        expect(state.derived()).toEqual(
          failResult === "forget.mark" ? before : { chunks: [], sources: [], cache: [] },
        );
        expect(await fs.readFile(state.memoryPath, "utf8")).toBe(state.content);
        expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual(origins);

        restore();
        await forgetMemoryEntries(state.params);
        expect(state.derived()).toEqual({ chunks: [], sources: [], cache: [] });
        expect(await fs.readFile(state.memoryPath, "utf8")).toBe(state.retained);
        expect(await listMemoryEntryOrigins({ agentId: "main" })).toEqual([]);
        expect(readMemoryForgetTombstonesForTest({ agentId: "main" })).toEqual(tombstones);
      } finally {
        restore();
      }
    },
  );

  it.each(["schema commit", "business transaction"] as const)(
    "preserves first-use schema boundaries when %s admission is refused",
    async (refusal) => {
      const state = await seedSelectedMemory(false);
      const before = state.derived();
      const beforeRevision = state.revision();
      const version = state.db.prepare("PRAGMA user_version").get();
      expect(state.optionalTables()).toEqual([]);
      const originalError = new Error(`injected ${refusal} refusal`);
      const requests: string[] = [];
      let transactions = 0;
      let refused = false;
      const sources: Array<Parameters<typeof sqliteRuntime.openOpenClawAgentSqliteWorkerStore>[1]> =
        [];
      const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStore;
      const observer = vi
        .spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStore")
        .mockImplementation((options, source, worker) => {
          if (
            source !== state.db ||
            worker.moduleUrl.href !==
              resolveRuntimeWorkerUrl(memoryCpuProcessEntrypoints.entryOrigins).href
          ) {
            return open(options, source, worker);
          }
          sources.push(source);
          return open(options, source, {
            ...worker,
            assertAdmission(request) {
              const original = worker.assertAdmission ? worker.assertAdmission(request) : request;
              if (original.stage === "transaction" || original.stage === "commit") {
                requests.push(original.stage);
              }
              if (original.stage === "transaction") {
                transactions++;
              }
              if (
                (refusal === "schema commit" &&
                  original.stage === "commit" &&
                  transactions === 1) ||
                (refusal === "business transaction" &&
                  original.stage === "transaction" &&
                  transactions === 2)
              ) {
                refused = true;
                throw originalError;
              }
              return original;
            },
          });
        });
      try {
        if (refusal === "schema commit") {
          // A failed factory retires the native owner; its uncertain settlement outranks the refusal.
          await expect(forgetMemoryEntries(state.params)).rejects.toMatchObject({
            code: "outcome-unknown",
            message: expect.stringContaining("Agent publication binding did not settle"),
          });
        } else {
          await expect(forgetMemoryEntries(state.params)).rejects.toThrow(originalError.message);
        }
        expect(sources).toHaveLength(1);
        expect(sources[0] === state.db).toBe(true);
        expect(refused).toBe(true);
        expect(requests).toEqual(
          refusal === "schema commit"
            ? ["transaction", "commit"]
            : ["transaction", "commit", "transaction"],
        );
        expect(state.optionalTables()).toEqual(
          refusal === "schema commit" ? [] : [{ name: "memory_session_tombstones" }],
        );
        expect(readMemoryForgetTombstonesForTest({ agentId: "main" })).toEqual([]);
        expect(state.derived()).toEqual(before);
        expect(state.revision()).toEqual(beforeRevision);
        expect(await fs.readFile(state.memoryPath, "utf8")).toBe(state.content);
        expect(state.db.prepare("PRAGMA user_version").get()).toEqual(version);

        observer.mockRestore();
        await forgetMemoryEntries(state.params);
        expect(state.optionalTables()).toEqual([{ name: "memory_session_tombstones" }]);
        expect(state.derived()).toEqual({ chunks: [], sources: [], cache: [] });
        expect(await fs.readFile(state.memoryPath, "utf8")).not.toContain("Private violet fact.");
        expect(await fs.readFile(state.memoryPath, "utf8")).toContain(
          "Keep the unrelated amber fact.",
        );
        expect(readMemoryForgetTombstonesForTest({ agentId: "main" })).toMatchObject([
          { sessionId: "target", reason: "forgotten" },
        ]);
        expect(state.db.prepare("PRAGMA user_version").get()).toEqual(version);
      } finally {
        observer.mockRestore();
      }
    },
  );
});
