import fs from "node:fs/promises";
import path from "node:path";
import { encodeMemoryEmbedding } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveRuntimeWorkerUrl } from "openclaw/plugin-sdk/process-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { requireNativeSqliteDatabase } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { describe, expect, it, vi } from "vitest";
import { observeMemoryForgetWorker } from "./memory-forget-fault.test-support.js";
import {
  memoryForgetHarness,
  memoryOrigin,
  memoryIndexFixture,
} from "./memory-forget.suite.test-support.js";
import { seedMemoryForgetSession } from "./memory-forget.test-helpers.js";
import { memoryCpuProcessEntrypoints } from "./memory/manager-cpu-entrypoints.js";

describe("memory forget worker settlement", () => {
  const h = memoryForgetHarness();
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
    const derived = () => ({
      chunks: db.prepare("SELECT * FROM memory_index_chunks ORDER BY id").all(),
      sources: db.prepare("SELECT * FROM memory_index_sources ORDER BY id").all(),
      cache: db.prepare("SELECT * FROM memory_embedding_cache ORDER BY hash").all(),
    });
    const optionalTables = () =>
      db
        .prepare(
          "SELECT name FROM sqlite_schema WHERE name IN ('memory_entry_origins', 'memory_session_tombstones') ORDER BY name",
        )
        .all();
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
      const origins = await h.origins();
      const reportPath = path.join(h.stateDir, "forget-native-report.jsonl");
      const restore = observeMemoryForgetWorker(state.db, { failResult, reportPath });
      try {
        await expect(forget()).rejects.toMatchObject({
          message: expect.stringContaining("injected committed " + failResult + " reply failure"),
        });
        const nativeReports = (await fs.readFile(reportPath, "utf8"))
          .trim()
          .split("\n")
          .map((line): unknown => JSON.parse(line));
        expect(nativeReports).toEqual([
          { tombstoneInserts: 1, sourceDeletes: failResult === "forget.purge" ? 1 : 0 },
        ]);
        const tombstones = h.tombstones();
        expect(tombstones).toEqual([
          {
            sessionId: "target",
            agentId: "main",
            reason: "forgotten",
            createdAt: expect.any(Number),
          },
        ]);
        expect(await state.snapshot()).toEqual({
          ...before,
          derived: failResult === "forget.mark" ? before.derived : empty,
          revision: before.revision + (failResult === "forget.mark" ? 1 : 2),
        });
        expect(await h.origins()).toEqual(origins);
        restore();
        await forget();
        expect(await state.snapshot()).toEqual({
          derived: empty,
          revision: before.revision + 3,
          memory: state.retained,
        });
        expect(await h.origins()).toEqual([]);
        expect(h.tombstones()).toEqual(tombstones);
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
      const requests: string[] = [];
      let transactions = 0;
      let refused = false;
      const paths: Array<string | undefined> = [];
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
          paths.push(options.path);
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
        expect({ paths, refused, requests, tables: state.optionalTables() }).toEqual({
          paths: [state.db.location()],
          refused: true,
          requests: schemaCommit
            ? ["transaction", "commit"]
            : ["transaction", "commit", "transaction"],
          tables: schemaCommit ? [] : [{ name: "memory_session_tombstones" }],
        });
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
