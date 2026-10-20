import path from "node:path";
import { deserialize } from "node:v8";
import { MessagePort, Worker } from "node:worker_threads";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
      schema: { cacheEnabled: true, ftsEnabled: false },
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

function indexCommands(calls: unknown[][]): string[] {
  return calls.flatMap(([message]) => {
    if (
      typeof message === "object" &&
      message !== null &&
      "input" in message &&
      typeof message.input === "object" &&
      message.input !== null &&
      "kind" in message.input &&
      message.input.kind === "index-read" &&
      "command" in message.input &&
      typeof message.input.command === "object" &&
      message.input.command !== null &&
      "type" in message.input.command &&
      typeof message.input.command.type === "string"
    ) {
      return [message.input.command.type];
    }
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

function recordIndexCommands(target: "messagePort" | "worker") {
  const commands: string[] = [];
  const record = (message: unknown, send: () => void) => {
    const dispatched = indexCommands([[message]]);
    send();
    commands.push(...dispatched);
  };
  if (target === "messagePort") {
    const prototype: Pick<MessagePort, "postMessage"> = MessagePort.prototype;
    const nativePost = prototype.postMessage;
    const posts = vi.spyOn(prototype, "postMessage").mockImplementation(function (
      this: MessagePort,
      message: unknown,
      options,
    ) {
      record(message, () => nativePost.call(this, message, options));
    });
    return { commands, restore: () => posts.mockRestore() };
  }
  const prototype: Pick<Worker, "postMessage"> = Worker.prototype;
  const nativePost = prototype.postMessage;
  const posts = vi.spyOn(prototype, "postMessage").mockImplementation(function (
    this: Worker,
    message: unknown,
    transferList,
  ) {
    record(message, () => nativePost.call(this, message, transferList));
  });
  return { commands, restore: () => posts.mockRestore() };
}

it("retains session entry facts across memory publication and refreshes after a session write", async () => {
  await withPublishedIndex(async (database) => {
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
      messages.mock.calls.filter(([message]) => {
        return (
          typeof message === "object" &&
          message !== null &&
          "input" in message &&
          typeof message.input === "object" &&
          message.input !== null &&
          "kind" in message.input &&
          message.input.kind === "session-entry-read"
        );
      });
    try {
      await database.writeMetadata(metadata);
      await database.replaceSource(
        sourceReplacement("fts-only"),
        () => {},
        async () => true,
      );
      expect((await getSessionEntryAsync(target))?.label).toBe("Before");
      expect(entryReads()).toEqual([]);

      await withOpenClawAgentDatabaseWrite(
        { agentId: "main", path: target.storePath },
        ({ db }) => {
          db.prepare(
            "UPDATE session_nodes SET entry_json = ?, updated_at = 2, label = 'After' WHERE session_key = ?",
          ).run(
            JSON.stringify({ sessionId: "memory-publication", updatedAt: 2, label: "After" }),
            target.sessionKey,
          );
        },
      );
      expect((await getSessionEntryAsync(target))?.label).toBe("After");
      expect(entryReads()).toHaveLength(1);
    } finally {
      messages.mockRestore();
    }
  });
});

it("retains published memory facts across session and embedding-cache writes", async () => {
  await withPublishedIndex(async (database) => {
    await database.writeMetadata(metadata);
    const facts = database.facts;
    const identities = [{ provider: "test", model: "test", providerKey: "test" }];
    const readCache = () =>
      database.read(
        { type: "cache.read", input: { providerIdentities: identities, hashes: ["test"] } },
        () => {},
      );
    expect(await readCache()).toEqual(new Map());
    const messages = recordIndexCommands("messagePort");
    try {
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
        () => {},
        () => true,
      );
      expect(await readCache()).toEqual(new Map([["test", [1]]]));
      await database.mutateEmbeddingCache(
        { kind: "clear", identities },
        () => {},
        () => true,
      );
      expect(await readCache()).toEqual(new Map());
      await database.refreshFacts();
      expect(database.facts).toBe(facts);
      expect(messages.commands).not.toContain("index.facts");

      await database.writeMetadata({ ...metadata, model: "updated-model" });
      await database.refreshFacts();
      expect(database.facts.meta?.model).toBe("updated-model");
      expect(messages.commands).not.toContain("index.facts");
    } finally {
      messages.restore();
    }
  });
});

it("keeps no-op and refused publication preparation SQL-free without opening a worker", async () => {
  await withOpenClawTestState({ scenario: "minimal" }, async () => {
    const borrowed = borrowOpenClawAgentDatabase({ agentId: "main" });
    const source = readOpenClawAgentDatabaseIdentity(borrowed);
    const database = new MemoryIndexDatabase(
      requireNativeSqliteDatabase(borrowed.db),
      borrowed.release,
      false,
      {
        agentId: "main",
        path: source.filename,
      },
    );
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

it("reads committed index state while another operation holds the writer FIFO", async ({
  signal,
}) => {
  await withPublishedIndex(async (database) => {
    await database.replaceSource(
      sourceReplacement("fts-only"),
      () => {},
      async () => true,
    );
    await database.closePublicationWorker();
    const sql = observeHostDataSql();
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const abort = () => release.resolve();
    signal.addEventListener("abort", abort, { once: true });
    const holding = runOpenClawAgentWriteAdmission(database.writeOptions!, async () => {
      entered.resolve();
      await release.promise;
    });
    try {
      await entered.promise;
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
    } finally {
      release.resolve();
      await holding;
      signal.removeEventListener("abort", abort);
      sql.restore();
    }
  });
});

it("publishes committed metadata, presence, and revision facts with source mutations", async () => {
  await withPublishedIndex(async (database) => {
    const initialRevision = database.facts.revision;
    await database.writeMetadata(metadata);
    expect(database.facts).toMatchObject({
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
    const messages = recordIndexCommands("worker");
    try {
      for (let turn = 0; turn < 3; turn++) {
        await database.refreshFacts();
        expect(database.facts).toMatchObject({
          meta: metadata,
          serialized: JSON.stringify(metadata),
          revision: initialRevision + 1,
          hasIndexedChunks: false,
          hasSemanticChunks: false,
          invalidatedSources: [],
          hasVectorTable: false,
          vectorState: { state: "empty" },
        });
      }
      expect(sql.queries).toEqual([]);
      expect(messages.commands).toEqual(["index.facts"]);
    } finally {
      messages.restore();
      sql.restore();
    }
  });
});

it("refreshes invalidated source and vector facts after an in-process write", async () => {
  await withPublishedIndex(async (database) => {
    await database.replaceSource(
      sourceReplacement("test-model"),
      () => {},
      async () => true,
    );
    await withOpenClawAgentDatabaseWrite(database.writeOptions!, ({ db }) => {
      db.prepare("UPDATE memory_index_sources SET hash = '' WHERE source = ?").run("memory");
      db.prepare(
        "INSERT INTO memory_index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      ).run("memory_vector_rebuild_v1", "1");
    });
    const sql = observeHostDataSql();
    try {
      await database.refreshFacts();
      expect(database.facts.invalidatedSources).toEqual(["memory"]);
      expect(database.facts.vectorState).toEqual({ state: "incomplete" });
      expect(sql.queries).toEqual([]);
    } finally {
      sql.restore();
    }
    await withOpenClawAgentDatabaseWrite(database.writeOptions!, ({ db }) => {
      db.prepare("UPDATE memory_index_sources SET hash = ? WHERE source = ?").run(
        "restored",
        "memory",
      );
      db.prepare("UPDATE memory_index_meta SET value = ? WHERE key = ?").run(
        "clean",
        "memory_vector_rebuild_v1",
      );
    });
    await database.refreshFacts();
    expect(database.facts.invalidatedSources).toEqual([]);
    expect(database.facts.vectorState).toEqual({ state: "empty" });
  });
});
