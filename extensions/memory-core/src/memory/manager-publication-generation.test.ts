import path from "node:path";
import { deserialize } from "node:v8";
import { MessagePort, Worker } from "node:worker_threads";
import {
  getSessionEntryAsync,
  upsertSessionEntry,
} from "openclaw/plugin-sdk/session-store-runtime";
import {
  borrowOpenClawAgentDatabase,
  readOpenClawAgentDatabaseIdentity,
  runOpenClawAgentWriteAdmission,
  withOpenClawAgentDatabaseWrite,
} from "openclaw/plugin-sdk/sqlite-runtime";
import {
  requireNativeSqliteDatabase,
  observeHostDataSql,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { withOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, expect, it, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import type { MemoryIndexMeta } from "./manager-reindex-state.js";
import type { MemorySourceIndexReplacement } from "./manager-source-index-kernel.js";

const metadata: MemoryIndexMeta = {
  provider: "test-provider",
  model: "test-model",
  chunkTokens: 400,
  chunkOverlap: 80,
};
const emptyChunks = { hasIndexedChunks: false, hasSemanticChunks: false };
const metadataFacts = { meta: metadata, serialized: JSON.stringify(metadata) };
const emptyFacts = { ...metadataFacts, ...emptyChunks };
const source = { source: "memory", path: "memory/current.md" } as const;
const sourceHash = { type: "source.hash", input: source } as const;
const noOp = () => {};

function publish(database: MemoryIndexDatabase, model: string) {
  const input: MemorySourceIndexReplacement = {
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
  return database.replaceSource(input, noOp, async () => true);
}
const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object";

function indexCommands(calls: unknown[][]): string[] {
  return calls.flatMap(([message]) => {
    if (!isRecord(message)) {
      return [];
    }
    if (
      isRecord(message.input) &&
      message.input.kind === "index-read" &&
      isRecord(message.input.command) &&
      typeof message.input.command.type === "string"
    ) {
      return [message.input.command.type];
    }
    if (message.type !== "execute" || !(message.input instanceof Uint8Array)) {
      return [];
    }
    const command = deserialize(message.input) as {
      type: string;
      input?: { command?: { type: string } };
    };
    return [command.input?.command?.type ?? command.type];
  });
}

const test = it.extend<{ database: MemoryIndexDatabase }>({
  database: async ({ task: _task }, use) => {
    await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
      const database = await MemoryIndexDatabase.openPublished({
        agentId: "main",
        writeOptions: { agentId: "main", path: path.join(state.stateDir, "agent.sqlite") },
        readOnly: false,
        allowExtension: false,
        schema: { cacheEnabled: true, ftsEnabled: false },
      });
      try {
        await use(database);
      } finally {
        restoreObservations();
        await database.closeShadow();
      }
    });
  },
});

const revision = (database: MemoryIndexDatabase) =>
  database.db.prepare("SELECT revision FROM memory_index_state WHERE id = 1").get()?.revision;

const restores: Array<() => void> = [];
function restoreObservations() {
  restores.splice(0).forEach((restore) => restore());
  vi.restoreAllMocks();
}
afterEach(restoreObservations);
function observeSql() {
  const sql = observeHostDataSql();
  restores.unshift(() => sql.restore());
  return sql;
}

function recordIndexCommands(target: MessagePort | Worker) {
  const posts = vi.spyOn(target, "postMessage");
  return () => indexCommands(posts.mock.calls);
}

test("retains session facts through publication; refreshes on session write", async ({
  database,
}) => {
  const target = {
    agentId: "main",
    storePath: database.db.location()!,
    sessionKey: "agent:main:memory-publication",
  };
  await upsertSessionEntry({
    ...target,
    entry: { sessionId: "memory-publication", updatedAt: 1, label: "Before" },
  });
  expect((await getSessionEntryAsync(target))?.label).toBe("Before");
  const messages = vi.spyOn(MessagePort.prototype, "postMessage");
  const entryReads = () =>
    messages.mock.calls.filter(
      ([message]) =>
        isRecord(message) && isRecord(message.input) && message.input.kind === "session-entry-read",
    );
  await database.writeMetadata(metadata);
  await publish(database, "fts-only");
  expect((await getSessionEntryAsync(target))?.label).toBe("Before");
  expect(entryReads()).toEqual([]);

  await withOpenClawAgentDatabaseWrite({ agentId: "main", path: target.storePath }, ({ db }) => {
    db.prepare(
      "UPDATE session_nodes SET entry_json = ?, updated_at = 2, label = 'After' WHERE session_key = ?",
    ).run(
      JSON.stringify({ sessionId: "memory-publication", updatedAt: 2, label: "After" }),
      target.sessionKey,
    );
  });
  expect((await getSessionEntryAsync(target))?.label).toBe("After");
  expect(entryReads()).toHaveLength(1);
});

test("retains memory facts across session and embedding-cache writes", async ({ database }) => {
  await database.writeMetadata(metadata);
  const facts = database.facts;
  const messages = recordIndexCommands(MessagePort.prototype);
  await upsertSessionEntry({
    agentId: "main",
    storePath: database.db.location()!,
    sessionKey: "agent:main:memory-facts",
    entry: { sessionId: "memory-facts", updatedAt: 1 },
  });
  await database.refreshFacts();
  await database.mutateEmbeddingCache(
    {
      kind: "upsert",
      header: {
        agentId: "main",
        provider: { id: "test", model: "test" },
        providerKey: "test",
        maxEntries: 2,
      },
      entries: [{ hash: "test", embedding: [1] }],
    },
    noOp,
    () => true,
  );
  await database.refreshFacts();
  expect(database.facts).toBe(facts);
  expect(messages()).not.toContain("index.facts");

  await database.writeMetadata({ ...metadata, model: "updated-model" });
  await database.refreshFacts();
  expect(database.facts.meta?.model).toBe("updated-model");
  expect(messages()).not.toContain("index.facts");
});

it("keeps no-op and refused publication preparation SQL-free without opening a worker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const borrowed = borrowOpenClawAgentDatabase({ agentId: "main" });
    const identity = readOpenClawAgentDatabaseIdentity(borrowed);
    const database = new MemoryIndexDatabase(
      requireNativeSqliteDatabase(borrowed.db),
      borrowed.release,
      false,
      { agentId: "main", path: identity.filename },
    );
    const sql = observeSql();
    const messages = vi.spyOn(Worker.prototype, "postMessage");
    try {
      await database.withPublicationGeneration(async () => noOp());
      const refused = new Error("synthetic preparation refusal");
      await expect(
        database.withPublicationGeneration(async () => {
          throw refused;
        }),
      ).rejects.toBe(refused);
      expect(sql.queries).toEqual([]);
      expect(
        messages.mock.calls.filter(
          ([value]) =>
            isRecord(value) && value.type === "open" && value.databasePath === identity.filename,
        ),
      ).toEqual([]);
    } finally {
      restoreObservations();
      borrowed.release();
    }
  });
});

test("reads committed state while another operation holds the writer FIFO", async ({
  database,
  signal,
}) => {
  await publish(database, "fts-only");
  await database.closePublicationWorker();
  const sql = observeSql();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const abort = () => release.resolve();
  signal.addEventListener("abort", abort, { once: true });
  const holding = runOpenClawAgentWriteAdmission(database.writeOptions!, async () => {
    entered.resolve();
    await release.promise;
  });
  try {
    await entered.promise;
    for (let turn = 0; turn < 2; turn++) {
      expect(await database.read(sourceHash, noOp)).toBe("fts-only");
      await database.closePublicationWorker();
    }
    expect(sql.queries).toEqual([]);
    await database.refreshFacts();
    expect(database.facts).toMatchObject({ hasIndexedChunks: true, hasSemanticChunks: false });
    expect(sql.queries).toEqual([]);
  } finally {
    release.resolve();
    await holding;
    signal.removeEventListener("abort", abort);
  }
});

test("publishes metadata, presence and revision with source mutations", async ({ database }) => {
  const initialRevision = database.facts.revision;
  await database.writeMetadata(metadata);
  expect(database.facts).toMatchObject({ ...emptyFacts, revision: initialRevision });
  for (const model of ["fts-only", "test-model"]) {
    await publish(database, model);
    expect(database.facts).toMatchObject({
      meta: metadata,
      hasIndexedChunks: true,
      hasSemanticChunks: model !== "fts-only",
      revision: revision(database),
    });
    expect(database.facts.revision).toBeGreaterThan(initialRevision);
  }
  expect(await database.deleteSource({ ...source, expectedHash: "test-model" }, noOp)).toBe(true);
  expect(database.facts).toMatchObject({ ...emptyFacts, revision: revision(database) });
});

test("refreshes facts once after another in-process writer commits", async ({ database }) => {
  await database.refreshFacts();
  const initialRevision = database.facts.revision;
  await withOpenClawAgentDatabaseWrite(database.writeOptions!, ({ db }) => {
    db.prepare("INSERT INTO memory_index_meta (key, value) VALUES (?, ?)").run(
      "memory_index_meta_v1",
      JSON.stringify(metadata),
    );
    db.prepare("UPDATE memory_index_state SET revision = revision + 1 WHERE id = 1").run();
  });
  const sql = observeSql();
  const messages = recordIndexCommands(Worker.prototype);
  for (let turn = 0; turn < 3; turn++) {
    await database.refreshFacts();
    expect(database.facts).toMatchObject({
      ...emptyFacts,
      revision: initialRevision + 1,
      invalidatedSources: [],
      hasVectorTable: false,
      vectorState: { state: "empty" },
    });
  }
  expect(sql.queries).toEqual([]);
  expect(messages()).toEqual(["index.facts"]);
});

test("refreshes invalidated source and vector facts after a write", async ({ database }) => {
  await publish(database, "test-model");
  for (const [hash, rebuild, state] of [
    ["", "1", "incomplete"],
    ["restored", "clean", "empty"],
  ] as const) {
    await withOpenClawAgentDatabaseWrite(database.writeOptions!, ({ db }) => {
      db.prepare("UPDATE memory_index_sources SET hash = ? WHERE source = ?").run(hash, "memory");
      db.prepare(
        "INSERT INTO memory_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("memory_vector_rebuild_v1", rebuild);
    });
    const sql = observeSql();
    await database.refreshFacts();
    expect(database.facts.invalidatedSources).toEqual(hash ? [] : ["memory"]);
    expect(database.facts.vectorState).toEqual({ state });
    expect(sql.queries).toEqual([]);
    sql.restore();
  }
});
