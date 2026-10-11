import path from "node:path";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import {
  borrowOpenClawAgentDatabase,
  readOpenClawAgentDatabaseIdentity,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import { observeHostDataSql } from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

const metadata: MemoryIndexMeta = {
  provider: "test-provider",
  model: "test-model",
  chunkTokens: 400,
  chunkOverlap: 80,
};

async function withPublishedIndex(run: (database: MemoryIndexDatabase) => Promise<void>) {
  await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
    const database = await MemoryIndexDatabase.openPublished({
      agentId: "main",
      writeOptions: { agentId: "main", path: path.join(state.stateDir, "agent.sqlite") },
      readOnly: false,
      allowExtension: false,
      schema: { cacheEnabled: false, ftsEnabled: false },
    });
    try {
      await run(database);
    } finally {
      await database.closeShadow();
    }
  });
}

function sourceReplacement(model: string): MemorySourceIndexReplacement {
  return {
    source: "memory",
    entry: { path: "memory/current.md", hash: model, mtimeMs: 1, size: 4 },
    model,
    now: 1,
    vectorReady: false,
    embeddings: model === "fts-only" ? [] : [[0.5]],
    chunks: [
      {
        startLine: 1,
        endLine: 1,
        text: "test",
        hash: "chunk",
        importance: null,
        triggers: null,
        projectKey: null,
      },
    ],
  };
}

function publicationCommands(calls: unknown[][]): string[] {
  return calls.flatMap(([message]) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "execute" ||
      !("input" in message) ||
      !(message.input instanceof Uint8Array)
    ) {
      return [];
    }
    const command = deserialize(message.input) as {
      type: string;
      input?: { command?: { type: string } };
    };
    return [command.input?.command?.type ?? command.type];
  });
}

it("keeps no-op and refused publication preparation SQL-free without opening a worker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const borrowed = borrowOpenClawAgentDatabase({ agentId: "main" });
    const source = readOpenClawAgentDatabaseIdentity(borrowed);
    const database = new MemoryIndexDatabase(borrowed.db, borrowed.release, false, {
      agentId: "main",
      path: source.filename,
    });
    const sql = observeHostDataSql();
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    try {
      await database.withPublicationGeneration(async () => {});
      const refused = new Error("synthetic preparation refusal");
      await expect(
        database.withPublicationGeneration(async () => {
          throw refused;
        }),
      ).rejects.toBe(refused);
      expect(sql.queries).toEqual([]);
      expect(
        messages.mock.calls.filter(([request]) => {
          const value: unknown = request;
          return (
            value !== null &&
            typeof value === "object" &&
            "type" in value &&
            value.type === "open" &&
            "databasePath" in value &&
            value.databasePath === source.filename
          );
        }),
      ).toEqual([]);
    } finally {
      messages.mockRestore();
      sql.restore();
      borrowed.release();
    }
  });
});

it("reuses retained facts and connection policy after publication worker recreation", async () => {
  await withPublishedIndex(async (database) => {
    await database.replaceSource(
      sourceReplacement("fts-only"),
      () => {},
      async () => true,
    );
    await database.closePublicationWorker();
    const sql = observeHostDataSql();
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    try {
      for (let turn = 0; turn < 2; turn++) {
        expect(
          await database.read(
            { type: "source.hash", input: { source: "memory", path: "memory/current.md" } },
            () => {},
          ),
        ).toBe("fts-only");
        await database.closePublicationWorker();
      }
      expect(sql.queries).toEqual([]);
      await database.refreshFacts();
      expect(database.facts).toMatchObject({ hasIndexedChunks: true, hasSemanticChunks: false });
      expect(sql.queries).toEqual([]);
      expect(publicationCommands(messages.mock.calls)).toEqual(["source.hash", "source.hash"]);
    } finally {
      messages.mockRestore();
      sql.restore();
    }
  });
});

it("publishes committed metadata, presence, and revision facts with source mutations", async () => {
  await withPublishedIndex(async (database) => {
    const initialRevision = database.facts.revision;
    await database.writeMetadata(metadata);
    expect(database.facts).toEqual({
      meta: metadata,
      serialized: JSON.stringify(metadata),
      revision: initialRevision,
      hasIndexedChunks: false,
      hasSemanticChunks: false,
    });
    for (const model of ["fts-only", "test-model"]) {
      await database.replaceSource(
        sourceReplacement(model),
        () => {},
        async () => true,
      );
      expect(database.facts).toMatchObject({
        meta: metadata,
        hasIndexedChunks: true,
        hasSemanticChunks: model !== "fts-only",
        revision: database.db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()
          ?.revision,
      });
      expect(database.facts.revision).toBeGreaterThan(initialRevision);
    }
    expect(
      await database.deleteSource(
        { source: "memory", path: "memory/current.md", expectedHash: "test-model" },
        () => {},
      ),
    ).toBe(true);
    expect(database.facts).toMatchObject({
      meta: metadata,
      hasIndexedChunks: false,
      hasSemanticChunks: false,
      revision: database.db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()
        ?.revision,
    });
  });
});

it("refreshes facts once after another in-process writer commits", async () => {
  await withPublishedIndex(async (database) => {
    await database.refreshFacts();
    const initialRevision = database.facts.revision;
    await withOpenClawAgentDatabaseWrite(database.writeOptions!, ({ db }) => {
      db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
        "memory_index_meta_v1",
        JSON.stringify(metadata),
      );
      db.prepare("UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1").run();
    });
    const sql = observeHostDataSql();
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    try {
      for (let turn = 0; turn < 3; turn++) {
        await database.refreshFacts();
        expect(database.facts).toEqual({
          meta: metadata,
          serialized: JSON.stringify(metadata),
          revision: initialRevision + 1,
          hasIndexedChunks: false,
          hasSemanticChunks: false,
        });
      }
      expect(sql.queries).toEqual([]);
      expect(publicationCommands(messages.mock.calls)).toEqual(["index.facts"]);
    } finally {
      messages.mockRestore();
      sql.restore();
    }
  });
});
