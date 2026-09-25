import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("memory source changes during indexing", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });

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
      await fs.writeFile(changingFile, "Original alpha source.");
      await fs.writeFile(siblingFile, "Original beta sibling.");
      const cfg = fixture.createConfig({
        provider,
        batchEnabled: true,
        cacheEnabled: true,
        vectorEnabled: false,
        sources: ["memory"],
      });
      const manager = await fixture.getFreshManager(cfg, "cli");
      await manager.sync({ reason: "baseline", force: true });
      await fs.writeFile(changingFile, obsoleteContent);
      await fs.writeFile(siblingFile, "Updated beta sibling survives the concurrent edit.");
      Reflect.set(manager, "dirty", true);
      let releaseEmbedding = () => {};
      const embeddingGate = new Promise<void>((resolve) => {
        releaseEmbedding = resolve;
      });
      let changingSourceEntered = () => {};
      const changingSourceReady = new Promise<void>((resolve) => {
        changingSourceEntered = resolve;
      });
      fixture.provider.providerRuntimeBatchEntered = (_activeCalls, texts) => {
        if (texts.some((text) => text.includes("Obsolete alpha source"))) {
          fixture.provider.providerRuntimeBatchGate = embeddingGate;
          changingSourceEntered();
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
        await Promise.race([changingSourceReady, activeSync]);
        expect(fixture.provider.providerRuntimeBatchGate).toBe(embeddingGate);
        if (!maintenance) {
          expect(manager.status().dirty).toBe(true);
        }
        if (mutation === "delete") {
          await fs.unlink(changingFile);
        } else {
          await fs.writeFile(changingFile, latestContent);
        }
        releaseEmbedding();
        await expect(activeSync).resolves.toBeUndefined();
        const db = Reflect.get(manager, "db") as DatabaseSync;
        const indexedText = () =>
          db
            .prepare("SELECT text FROM memory_index_chunks")
            .all()
            .map((row) => row.text)
            .join("\n");
        expect(indexedText()).toContain("Updated beta sibling");
        expect(indexedText()).not.toContain("Obsolete alpha");
        expect(
          db
            .prepare("SELECT hash FROM memory_embedding_cache WHERE hash = ?")
            .get(hashText(obsoleteContent)),
        ).toBeUndefined();
        expect(manager.status().dirty).toBe(true);
        expect(Reflect.get(manager, "memoryFullRetryDirty")).toBe(false);

        fixture.provider.providerRuntimeBatchCalls = [];
        await manager.sync({ reason: "retry-source" });
        expect(manager.status().dirty).toBe(false);
        expect(indexedText()).toContain("Updated beta sibling");
        expect(indexedText()).not.toContain("Obsolete alpha");
        if (mutation === "delete") {
          expect(
            db
              .prepare("SELECT path FROM memory_index_sources WHERE path = ?")
              .get("memory/changing.md"),
          ).toBeUndefined();
        } else {
          expect(indexedText()).toContain("Latest alpha source");
          expect(
            db
              .prepare("SELECT hash FROM memory_embedding_cache WHERE hash = ?")
              .get(hashText(latestContent)),
          ).toEqual({ hash: hashText(latestContent) });
        }
        expect(fixture.provider.providerRuntimeBatchCalls.flat().join("\n")).not.toContain(
          "beta sibling",
        );
      } finally {
        releaseEmbedding();
        await activeSync.catch(() => undefined);
        fixture.provider.providerRuntimeBatchGate = null;
        fixture.provider.providerRuntimeBatchEntered = null;
      }
    },
  );

  it("revalidates the file after a real SQLite BEGIN collision before replacing its index", async () => {
    const memoryPath = path.join(fixture.paths.memory, "contended.md");
    await fs.writeFile(memoryPath, "Original indexed source.");
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["memory"], vectorEnabled: false }),
      "cli",
    );
    await manager.sync({ reason: "baseline", force: true });
    await fs.writeFile(memoryPath, "Obsolete source waiting for the writer.");
    Reflect.set(manager, "dirty", true);
    const databasePath = manager.status().dbPath;
    if (!databasePath) {
      throw new Error("Expected a memory index database path");
    }
    const db = Reflect.get(manager, "db") as DatabaseSync;
    const peer = new DatabaseSync(databasePath);
    const collision = createDeferred<void>();
    const revalidate = createDeferred<void>();
    let collisionObserved = false;
    let preparations = 0;
    // oxlint-disable-next-line typescript/unbound-method -- Invoked with the actual database owner.
    const replaceSource = MemoryIndexDatabase.prototype.replaceSource;
    const publicationSpy = vi
      .spyOn(MemoryIndexDatabase.prototype, "replaceSource")
      .mockImplementation(function (this: MemoryIndexDatabase, input, assertCurrent, prepare) {
        return replaceSource.call(this, input, assertCurrent, async () => {
          // The Worker retries only a refused native BEGIN. Observe the next
          // file check rather than a BEGIN on the application's connection.
          if (input.entry.path === "memory/contended.md" && ++preparations === 2) {
            collisionObserved = true;
            collision.resolve();
            await revalidate.promise;
          }
          return prepare();
        });
      });
    peer.exec("BEGIN IMMEDIATE");
    const sync = manager.sync({ reason: "watch" });
    try {
      await Promise.race([collision.promise, sync]);
      expect(collisionObserved).toBe(true);
      expect(peer.isTransaction).toBe(true);
      await fs.writeFile(memoryPath, "Current source after the writer collision.");
      peer.exec("ROLLBACK");
      revalidate.resolve();
      await sync;
      expect(
        db
          .prepare("SELECT text FROM memory_index_chunks WHERE path = ?")
          .all("memory/contended.md"),
      ).toEqual([{ text: "Original indexed source." }]);
      expect(manager.status().dirty).toBe(true);
      await manager.sync({ reason: "retry-current-source" });
      expect(
        db
          .prepare("SELECT text FROM memory_index_chunks WHERE path = ?")
          .all("memory/contended.md"),
      ).toEqual([{ text: "Current source after the writer collision." }]);
    } finally {
      revalidate.resolve();
      if (peer.isTransaction) {
        peer.exec("ROLLBACK");
      }
      await sync.catch(() => undefined);
      publicationSpy.mockRestore();
      peer.close();
    }
  });
  it("settles an earlier recall before deleting a stale memory source", async () => {
    const stalePath = "memory/stale.md";
    const siblingPath = "memory/2026-01-12.md";
    await fs.writeFile(path.join(fixture.paths.workspace, stalePath), "Obsolete violet source.");
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ provider: "none", sources: ["memory"], vectorEnabled: false }),
      "cli",
    );
    await manager.sync({ reason: "baseline", force: true });
    // SAFETY: The fixture owns this manager and its published native database.
    const db = Reflect.get(manager, "db") as DatabaseSync;
    const sibling = () =>
      db
        .prepare("SELECT id, hash, text FROM memory_index_chunks WHERE path = ? ORDER BY id")
        .all(siblingPath);
    const siblingBefore = sibling();
    expect(siblingBefore.length).toBeGreaterThan(0);
    expect(
      db.prepare("SELECT path FROM memory_index_sources WHERE path = ?").get(stalePath),
    ).toEqual({ path: stalePath });
    await fs.unlink(path.join(fixture.paths.workspace, stalePath));
    Reflect.set(manager, "dirty", true);

    const recallReading = createDeferred<void>();
    const releaseRecall = createDeferred<void>();
    const deletionAttempted = createDeferred<void>();
    const events: string[] = [];
    let readObserved = false;
    let deletionObserved = false;
    const readStore = recallStore.readStore;
    const readSpy = vi.spyOn(recallStore, "readStore").mockImplementationOnce(async (...args) => {
      const store = await readStore(...args);
      readObserved = true;
      recallReading.resolve();
      await releaseRecall.promise;
      return store;
    });
    // Observe only the protected caller. Delegate unchanged before signaling its attempt.
    // SAFETY: Observe the existing protected caller without changing its receiver or inputs.
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
        deletionObserved = true;
        deletionAttempted.resolve();
      }
      return pending;
    });
    const recordOrigins = memoryOrigins.recordMemoryEntryOrigins;
    const originsSpy = vi
      .spyOn(memoryOrigins, "recordMemoryEntryOrigins")
      .mockImplementation((params) => {
        const recorded = recordOrigins(params);
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
      await Promise.race([recallReading.promise, recall]);
      expect(readObserved, "real recall reached its locked store read").toBe(true);
      // Start from the test context, not from recall's reentrant workspace-lock context.
      sync = manager.sync({ reason: "watch" });
      void sync.catch(() => undefined);
      await Promise.race([deletionAttempted.promise, sync]);
      const publicationsWhileRecallHeld = publicationSpy.mock.calls.length;
      releaseRecall.resolve();
      await Promise.all([recall, sync]);

      expect(deletionObserved, "real incremental sync attempted stale-source deletion").toBe(true);
      expect(
        db.prepare("SELECT path FROM memory_index_sources WHERE path = ?").get(stalePath),
      ).toBeUndefined();
      expect(
        db.prepare("SELECT id FROM memory_index_chunks WHERE path = ?").all(stalePath),
      ).toEqual([]);
      expect(
        db.prepare("SELECT id FROM memory_index_chunks_fts WHERE path = ?").all(stalePath),
      ).toEqual([]);
      expect(sibling()).toEqual(siblingBefore);
      const recorded = memoryOrigins.listMemoryEntryOrigins({
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
      expect(db.prepare("PRAGMA integrity_check").all()).toEqual([{ integrity_check: "ok" }]);
      expect(publicationsWhileRecallHeld).toBe(0);
      expect(events).toEqual(["origins", "delete"]);
    } finally {
      releaseRecall.resolve();
      await Promise.allSettled([recall, ...(sync ? [sync] : [])]);
      publicationSpy.mockRestore();
      originsSpy.mockRestore();
      callerSpy.mockRestore();
      readSpy.mockRestore();
    }
  });
});
