import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setImmediate } from "node:timers/promises";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import * as sessions from "openclaw/plugin-sdk/memory-core-host-engine-sessions";
import { deleteSessionEntry } from "openclaw/plugin-sdk/session-store-runtime";
import { publishSessionTranscriptUpdateByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { resolveOpenClawAgentSqlitePath } from "openclaw/plugin-sdk/sqlite-runtime";
import * as sqliteRuntime from "openclaw/plugin-sdk/sqlite-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";
import * as reindexLock from "./manager-reindex-lock.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");
const embeddings = await import("./embeddings.js");
const listCorpus = sessions.listSessionTranscriptCorpusEntriesForAgent;

function observeCorpusPreparation() {
  const work: Array<ReturnType<typeof listCorpus>> = [];
  vi.spyOn(sessions, "listSessionTranscriptCorpusEntriesForAgent").mockImplementation((...args) => {
    const pending = listCorpus(...args);
    work.push(pending);
    return pending;
  });
  return { work };
}

function pauseCorpusFilesystem() {
  const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
  const entered = createDeferred<void>();
  const resume = createDeferred<void>();
  const realpath = fs.realpath.bind(fs);
  vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
    if (String(args[0]) === sessionsDir) {
      entered.resolve();
      await resume.promise;
    }
    return realpath(...args);
  });
  return {
    entered: entered.promise,
    resume: () => resume.resolve(),
  };
}

function observePublicationLifetime(events: string[]) {
  const capture = sqliteRuntime.captureOpenClawAgentDatabaseExecution;
  vi.spyOn(sqliteRuntime, "captureOpenClawAgentDatabaseExecution").mockImplementationOnce(
    (...args) => {
      const execution = capture(...args);
      events.push("retained");
      const release = execution.release.bind(execution);
      vi.spyOn(execution, "release").mockImplementation(async () => {
        await release();
        events.push("released");
      });
      return execution;
    },
  );
  const open = sqliteRuntime.openOpenClawAgentSqliteWorkerStoreV2;
  vi.spyOn(sqliteRuntime, "openOpenClawAgentSqliteWorkerStoreV2").mockImplementation(
    async (...args) => {
      const store = await open(...args);
      events.push("publication");
      const close = store.close.bind(store);
      vi.spyOn(store, "close").mockImplementation(async () => {
        await close();
        events.push("publication-closed");
      });
      return store;
    },
  );
}

describe("memory preparation shutdown", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  afterEach(() => vi.restoreAllMocks());
  const createConfig = () =>
    fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true });
  const seed = (sessionId = "pending-preparation") =>
    fixture.seedSessionTranscript({
      sessionId,
      messages: [{ role: "user", timestamp: 1, content: `Remember the violet ${sessionId}.` }],
    });

  it.each([false, true])(
    "retains publication through provider preparation and close (provider failure: %s)",
    async (failProvider) => {
      const manager = await fixture.getFreshManager(
        fixture.createConfig({
          provider: "openai",
          fallback: "none",
          sources: ["memory"],
          vectorEnabled: false,
        }),
        "cli",
      );
      const events: string[] = [];
      const entered = createDeferred<void>();
      const resume = createDeferred<void>();
      observePublicationLifetime(events);
      const createProvider = embeddings.createEmbeddingProvider;
      const providerFailure = new Error("controlled provider preparation failure");
      vi.spyOn(embeddings, "createEmbeddingProvider").mockImplementation(async (...args) => {
        events.push("provider");
        entered.resolve();
        await resume.promise;
        if (failProvider) {
          throw providerFailure;
        }
        return createProvider(...args);
      });
      const syncing = manager.sync({ reason: "post-compaction" });
      let closing: Promise<void> | undefined;
      try {
        await Promise.race([entered.promise, syncing]);
        expect(events).toEqual(["retained", "provider"]);
        closing = manager.close().then(() => {
          events.push("closed");
        });
        expect(events).toEqual(["retained", "provider"]);
        resume.resolve();
        const [syncResult, closeResult] = await Promise.allSettled([syncing, closing]);
        expect([syncResult.status, closeResult.status]).toEqual([
          failProvider ? "rejected" : "fulfilled",
          "fulfilled",
        ]);
        if (failProvider) {
          expect(syncResult).toMatchObject({
            reason: { message: expect.stringContaining(providerFailure.message) },
          });
        }
        expect(events).toEqual([
          "retained",
          "provider",
          ...(failProvider ? [] : ["publication", "publication-closed"]),
          "released",
          "closed",
        ]);
      } finally {
        resume.resolve();
        await Promise.allSettled([syncing, closing]);
      }
    },
  );

  it("retains accepted sync custody while keyword fallback waits for the next reindex lock", async () => {
    const manager = await fixture.getFreshManager(
      fixture.createConfig({ fallback: "none", sources: ["memory"], vectorEnabled: false }),
      "cli",
    );
    fixture.provider.embedBatchPermanentFailure = new Error("controlled embedding failure");
    const events: string[] = [];
    observePublicationLifetime(events);
    const entered = createDeferred<void>();
    const resume = createDeferred<void>();
    const acquire = reindexLock.waitForMemoryReindexLock;
    let acquisitions = 0;
    vi.spyOn(reindexLock, "waitForMemoryReindexLock").mockImplementation(async (...args) => {
      const sequence = ++acquisitions;
      if (sequence === 2) {
        entered.resolve();
        await resume.promise;
      }
      const acquired = await acquire(...args);
      return {
        ...acquired,
        release: async () => {
          await acquired.release();
          events.push(`lock-released-${sequence}`);
        },
      };
    });
    const searching = manager.search("zebra", { minScore: 0 });
    try {
      await Promise.race([entered.promise, searching]);
      expect(acquisitions).toBe(2);
      expect(events).toEqual(["retained", "lock-released-1"]);
      resume.resolve();
      expect(await searching).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: "memory/2026-01-12.md" })]),
      );
      expect(events).toEqual([
        "retained",
        "lock-released-1",
        "publication",
        "publication-closed",
        "lock-released-2",
        "released",
      ]);
    } finally {
      resume.resolve();
      await Promise.allSettled([searching]);
    }
  });

  it.each(["archive", "identity", "cli"] as const)(
    "joins %s discovery and indexing before releasing the database",
    async (mode) => {
      const cli = mode === "cli";
      await seed(cli ? "already-indexed" : "pending-preparation");
      const corpus = observeCorpusPreparation();
      const manager = await fixture.getFreshManager(createConfig(), cli ? "cli" : undefined);
      await Promise.all(corpus.work);
      await manager.sync({ reason: "baseline", force: true });
      await Promise.all(corpus.work);
      if (cli) {
        await seed("new-offline-session");
      } else {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      }
      const barrier = pauseCorpusFilesystem();
      let syncing: Promise<void> | undefined;
      let closing: Promise<void> | undefined;
      try {
        if (cli) {
          syncing = manager.sync({ reason: "cli" });
        } else {
          const target = {
            agentId: "main",
            sessionId: "pending-preparation",
            sessionKey: "agent:main:memory:pending-preparation",
            storePath: path.join(resolveSessionTranscriptsDirForAgent("main"), "sessions.json"),
          };
          if (mode === "archive") {
            await expect(
              deleteSessionEntry({
                ...target,
                archiveTranscript: true,
                expectedSessionId: target.sessionId,
              }),
            ).resolves.toBe(true);
          } else {
            await publishSessionTranscriptUpdateByIdentity(target);
            await vi.advanceTimersByTimeAsync(30_000);
          }
        }
        await barrier.entered;
        let closed = false;
        closing = manager.close().then(() => {
          closed = true;
        });
        await setImmediate();
        expect(closed).toBe(false);
        barrier.resume();
        await Promise.all([syncing, closing]);

        if (cli) {
          using observer = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
            readOnly: true,
          });
          const rows = observer
            .prepare("SELECT text FROM memory_index_chunks WHERE source = 'sessions'")
            .all();
          expect(rows).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                text: expect.stringContaining("violet new-offline-session"),
              }),
            ]),
          );
        } else {
          const mkdir = vi.spyOn(fsSync, "mkdirSync");
          await Promise.all(corpus.work);
          await vi.advanceTimersByTimeAsync(30_000);
          await setImmediate();
          expect(
            mkdir.mock.calls.filter(([directory]) =>
              String(directory).startsWith(`${fixture.paths.stateDir}${path.sep}`),
            ),
          ).toEqual([]);
        }
      } finally {
        barrier.resume();
        await Promise.allSettled([...corpus.work, syncing, closing]);
        if (!cli) {
          await vi.advanceTimersByTimeAsync(30_000);
          await Promise.allSettled(corpus.work);
          vi.useRealTimers();
        }
      }
    },
  );
});
