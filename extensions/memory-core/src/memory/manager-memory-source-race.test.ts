import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { hashText, type MemorySource } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { describe, expect, it, vi } from "vitest";
import * as memoryOrigins from "../memory-entry-origins.js";
import {
  readShortTermRecallEntries,
  recordShortTermRecalls,
} from "../short-term-promotion-record.js";
import * as recallStore from "../short-term-promotion-store.js";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import type { MemoryIndexManager } from "./manager.js";

function indexReader(manager: MemoryIndexManager) {
  // This fixture owns the manager and its published native database.
  const db = Reflect.get(manager, "db") as DatabaseSync;
  return {
    get: (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).get(...params),
    all: (sql: string, ...params: SQLInputValue[]) => db.prepare(sql).all(...params),
  };
}

const memoryIndex = await import("./index.js");

describe("memory source changes during indexing", () => {
  const fixture = createManagerIndexFixture(memoryIndex);
  async function baselineIndex(
    files: Record<string, string>,
    config: Parameters<typeof fixture.createConfig>[0] = {
      provider: "none",
      sources: ["memory"],
      vectorEnabled: false,
    },
  ) {
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(fixture.paths.memory, name), content);
    }
    const manager = await fixture.getFreshManager(fixture.createConfig(config), "cli");
    await manager.sync({ reason: "baseline", force: true });
    return manager;
  }

  it.each([
    ...["batch-test", "batch-wide-test"].flatMap((provider) =>
      [false, true].flatMap((force) =>
        ["change", "delete"].map((mutation) => ({ provider, force, mutation, maintenance: false })),
      ),
    ),
    ...["change", "delete"].map((mutation) => ({
      provider: "batch-test",
      force: true,
      mutation,
      maintenance: true,
    })),
  ])(
    "keeps $mutation local during $provider indexing (force=$force, maintenance=$maintenance)",
    async ({ provider, force, mutation, maintenance }) => {
      const changingFile = path.join(fixture.paths.memory, "changing.md");
      const siblingFile = path.join(fixture.paths.memory, "sibling.md");
      const obsoleteContent = "Obsolete alpha source awaiting embeddings.";
      const latestContent = "Latest alpha source after the concurrent edit.";
      const manager = await baselineIndex(
        { "changing.md": "Original alpha source.", "sibling.md": "Original beta sibling." },
        {
          provider,
          batchEnabled: true,
          cacheEnabled: true,
          vectorEnabled: false,
          sources: ["memory"],
        },
      );
      await fs.writeFile(changingFile, obsoleteContent);
      await fs.writeFile(siblingFile, "Updated beta sibling survives the concurrent edit.");
      Reflect.set(manager, "dirty", true);
      const embeddingGate = createDeferred<void>();
      const changingSourceReady = createDeferred<void>();
      fixture.provider.providerRuntimeBatchEntered = (_activeCalls, texts) => {
        if (texts.some((text) => text.includes("Obsolete alpha source"))) {
          fixture.provider.providerRuntimeBatchGate = embeddingGate.promise;
          changingSourceReady.resolve();
        }
      };
      if (maintenance) {
        Reflect.set(manager, "memoryFullRetryDirty", true);
      }
      const activeSync = maintenance
        ? (
            manager as unknown as {
              syncPublishedIndexInBackground: (params: { reason: string }) => Promise<void>;
            }
          ).syncPublishedIndexInBackground({ reason: "search" })
        : manager.sync({ reason: "watch", force });
      void activeSync.catch(() => undefined);
      try {
        await Promise.race([changingSourceReady.promise, activeSync]);
        expect(fixture.provider.providerRuntimeBatchGate).toBe(embeddingGate.promise);
        if (!maintenance) {
          expect(manager.status().dirty).toBe(true);
        }
        if (mutation === "delete") {
          await fs.unlink(changingFile);
        } else {
          await fs.writeFile(changingFile, latestContent);
        }
        embeddingGate.resolve();
        await expect(activeSync).resolves.toBeUndefined();
        const { all, get } = indexReader(manager);
        const indexedText = () =>
          all("SELECT text FROM memory_index_chunks")
            .map((row) => row.text)
            .join("\n");
        const expectCurrentSibling = () => {
          expect(indexedText()).toContain("Updated beta sibling");
          expect(indexedText()).not.toContain("Obsolete alpha");
        };
        expectCurrentSibling();
        expect(manager.status().dirty).toBe(true);
        expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(false);

        fixture.provider.providerRuntimeBatchCalls = [];
        await manager.sync({ reason: "retry-source" });
        expect(manager.status().dirty).toBe(false);
        expectCurrentSibling();
        if (mutation === "delete") {
          expect(
            get("SELECT path FROM memory_index_sources WHERE path = ?", "memory/changing.md"),
          ).toBeUndefined();
        } else {
          expect(indexedText()).toContain("Latest alpha source");
          expect(
            get("SELECT hash FROM memory_embedding_cache WHERE hash = ?", hashText(latestContent)),
          ).toEqual({ hash: hashText(latestContent) });
        }
        expect(fixture.provider.providerRuntimeBatchCalls.flat().join("\n")).not.toContain(
          "beta sibling",
        );
      } finally {
        embeddingGate.resolve();
        await activeSync.catch(() => undefined);
        fixture.provider.providerRuntimeBatchGate = null;
        fixture.provider.providerRuntimeBatchEntered = null;
      }
    },
  );

  it("settles an earlier recall before deleting a stale memory source", async () => {
    const stalePath = "memory/stale.md";
    const siblingPath = "memory/2026-01-12.md";
    const manager = await baselineIndex({ "stale.md": "Obsolete violet source." });
    const { all, get } = indexReader(manager);
    const sibling = () =>
      all("SELECT id, hash, text FROM memory_index_chunks WHERE path = ? ORDER BY id", siblingPath);
    const siblingBefore = sibling();
    expect(siblingBefore.length).toBeGreaterThan(0);
    expect(get("SELECT path FROM memory_index_sources WHERE path = ?", stalePath)).toEqual({
      path: stalePath,
    });
    await fs.unlink(path.join(fixture.paths.workspace, stalePath));
    Reflect.set(manager, "dirty", true);

    const recallReading = createDeferred<boolean>();
    const releaseRecall = createDeferred<void>();
    const deletionAttempted = createDeferred<boolean>();
    const events: string[] = [];
    const readStore = recallStore.readStore;
    const readSpy = vi.spyOn(recallStore, "readStore").mockImplementationOnce(async (...args) => {
      const store = await readStore(...args);
      recallReading.resolve(true);
      await releaseRecall.promise;
      return store;
    });
    // Delegate unchanged before signaling the protected caller's deletion attempt.
    const deletion = manager as unknown as {
      deleteIndexedFile(
        pathname: string,
        source: MemorySource,
        expectedHash?: string,
      ): Promise<void>;
    };
    const deleteIndexedFile = deletion.deleteIndexedFile.bind(manager);
    const callerSpy = vi.spyOn(deletion, "deleteIndexedFile").mockImplementation((...args) => {
      const pending = deleteIndexedFile(...args);
      if (args[0] === stalePath) {
        deletionAttempted.resolve(true);
      }
      return pending;
    });
    const recordOrigins = memoryOrigins.recordMemoryEntryOrigins;
    const originsSpy = vi
      .spyOn(memoryOrigins, "recordMemoryEntryOrigins")
      .mockImplementation(async (params) => {
        const recorded = await recordOrigins(params);
        events.push("origins");
        return recorded;
      });
    // oxlint-disable-next-line typescript/unbound-method -- Called with the actual database owner.
    const deleteSource = MemoryIndexDatabase.prototype.deleteSource;
    const publicationSpy = vi
      .spyOn(MemoryIndexDatabase.prototype, "deleteSource")
      .mockImplementation(function (this: MemoryIndexDatabase, ...args) {
        events.push("delete");
        return deleteSource.call(this, ...args);
      });
    const sessionId = "recall-before-source-deletion";
    const nowMs = Date.UTC(2026, 8, 16);
    const recall = recordShortTermRecalls({
      workspaceDir: fixture.paths.workspace,
      query: "retained preference",
      nowMs,
      results: [
        {
          path: siblingPath,
          startLine: 2,
          endLine: 2,
          source: "memory",
          score: 0.8,
          snippet: "Retained violet preference.",
          provenance: { originClass: "owner", sessionKind: "interactive", observedAt: nowMs },
          sessionOrigin: { agentId: "main", sessionId, sessionKey: `agent:main:${sessionId}` },
        },
      ],
    });
    void recall.catch(() => undefined);
    let sync: Promise<void> | undefined;
    try {
      await expect(Promise.race([recallReading.promise, recall])).resolves.toBe(true);
      // Start from the test context, not from recall's reentrant workspace-lock context.
      sync = manager.sync({ reason: "watch" });
      void sync.catch(() => undefined);
      await expect(Promise.race([deletionAttempted.promise, sync])).resolves.toBe(true);
      const publicationsWhileRecallHeld = publicationSpy.mock.calls.length;
      releaseRecall.resolve();
      await Promise.all([recall, sync]);

      expect(
        get("SELECT path FROM memory_index_sources WHERE path = ?", stalePath),
      ).toBeUndefined();
      for (const table of ["memory_index_chunks", "memory_index_chunks_fts"]) {
        expect(all(`SELECT id FROM ${table} WHERE path = ?`, stalePath)).toEqual([]);
      }
      expect(sibling()).toEqual(siblingBefore);
      const recorded = await memoryOrigins.listMemoryEntryOrigins({
        agentId: "main",
        sessionIds: [sessionId],
      });
      expect(recorded).toEqual([
        expect.objectContaining({
          agentId: "main",
          sessionId,
          sessionKey: `agent:main:${sessionId}`,
          originClass: "owner",
          observedAt: nowMs,
        }),
      ]);
      expect(
        await readShortTermRecallEntries({ workspaceDir: fixture.paths.workspace, nowMs }),
      ).toEqual([
        expect.objectContaining({ key: recorded[0]?.entryKey, path: siblingPath, recallCount: 1 }),
      ]);
      expect(all("PRAGMA integrity_check")).toEqual([{ integrity_check: "ok" }]);
      expect(publicationsWhileRecallHeld).toBe(0);
      expect(events).toEqual(["origins", "delete"]);
    } finally {
      releaseRecall.resolve();
      await Promise.allSettled([recall, ...(sync ? [sync] : [])]);
      for (const spy of [publicationSpy, originsSpy, callerSpy, readSpy]) {
        spy.mockRestore();
      }
    }
  });
});
