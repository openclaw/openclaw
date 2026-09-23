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
import { describe, expect, it, vi, type MockInstance } from "vitest";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

function observeCorpusPreparation() {
  const listCorpus = sessions.listSessionTranscriptCorpusEntriesForAgent;
  const work: Array<ReturnType<typeof listCorpus>> = [];
  const spy = vi
    .spyOn(sessions, "listSessionTranscriptCorpusEntriesForAgent")
    .mockImplementation((...args) => {
      const pending = listCorpus(...args);
      work.push(pending);
      return pending;
    });
  return { work, restore: () => spy.mockRestore() };
}

function pauseCorpusFilesystem() {
  const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
  const entered = createDeferred<void>();
  const resume = createDeferred<void>();
  const realpath = fs.realpath.bind(fs);
  const spy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
    if (String(args[0]) === sessionsDir) {
      entered.resolve();
      await resume.promise;
    }
    return realpath(...args);
  });
  return {
    entered: entered.promise,
    resume: () => resume.resolve(),
    restore: () => spy.mockRestore(),
  };
}

function expectNoStateDirectoryOpens(spy: MockInstance<typeof fsSync.mkdirSync>, stateDir: string) {
  expect(
    spy.mock.calls.filter(([directory]) => String(directory).startsWith(`${stateDir}${path.sep}`)),
  ).toEqual([]);
}

describe("memory preparation shutdown", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  const createConfig = () =>
    fixture.createConfig({ provider: "none", sources: ["sessions"], sessionMemory: true });
  const seed = (sessionId = "pending-preparation") =>
    fixture.seedSessionTranscript({
      sessionId,
      messages: [{ role: "user", timestamp: 1, content: `Remember the violet ${sessionId}.` }],
    });

  it.each(["archive", "identity"] as const)(
    "joins %s notification preparation before releasing the database",
    async (notification) => {
      await seed();
      const corpus = observeCorpusPreparation();
      const manager = await fixture.getFreshManager(createConfig());
      await Promise.all(corpus.work);
      await manager.sync({ reason: "baseline", force: true });
      await Promise.all(corpus.work);
      const barrier = pauseCorpusFilesystem();
      let closing: Promise<void> | undefined;
      let mkdirSpy: MockInstance<typeof fsSync.mkdirSync> | undefined;
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        const target = {
          agentId: "main",
          sessionId: "pending-preparation",
          sessionKey: "agent:main:memory:pending-preparation",
          storePath: path.join(resolveSessionTranscriptsDirForAgent("main"), "sessions.json"),
        };
        if (notification === "archive") {
          await expect(
            deleteSessionEntry({
              ...target,
              archiveTranscript: true,
              expectedSessionId: target.sessionId,
            }),
          ).resolves.toBe(true);
        } else {
          await publishSessionTranscriptUpdateByIdentity(target);
          await vi.advanceTimersByTimeAsync(5_000);
        }
        await barrier.entered;
        let closed = false;
        closing = manager.close().then(() => {
          closed = true;
        });
        await setImmediate();
        expect(closed).toBe(false);

        barrier.resume();
        await closing;
        mkdirSpy = vi.spyOn(fsSync, "mkdirSync");
        await Promise.all(corpus.work);
        await vi.advanceTimersByTimeAsync(5_000);
        await setImmediate();
        expectNoStateDirectoryOpens(mkdirSpy, fixture.paths.stateDir);
      } finally {
        barrier.resume();
        await Promise.allSettled([...corpus.work, closing]);
        await vi.advanceTimersByTimeAsync(5_000);
        await Promise.allSettled(corpus.work);
        vi.useRealTimers();
        barrier.restore();
        corpus.restore();
        mkdirSpy?.mockRestore();
      }
    },
  );

  it("finishes accepted CLI session discovery and indexing while closing", async () => {
    await seed("already-indexed");
    const manager = await fixture.getFreshManager(createConfig(), "cli");
    await manager.sync({ reason: "baseline", force: true });
    await seed("new-offline-session");
    const corpus = observeCorpusPreparation();
    const barrier = pauseCorpusFilesystem();
    let syncing: Promise<void> | undefined;
    let closing: Promise<void> | undefined;
    try {
      syncing = manager.sync({ reason: "cli" });
      await barrier.entered;
      let closed = false;
      closing = manager.close().then(() => {
        closed = true;
      });
      await setImmediate();
      expect(closed).toBe(false);
      barrier.resume();
      await Promise.all([syncing, closing]);

      const observer = new DatabaseSync(resolveOpenClawAgentSqlitePath({ agentId: "main" }), {
        readOnly: true,
      });
      try {
        const rows = observer
          .prepare("SELECT text FROM memory_index_chunks WHERE source = 'sessions'")
          .all();
        expect(rows.some((row) => String(row.text).includes("violet new-offline-session"))).toBe(
          true,
        );
      } finally {
        observer.close();
      }
    } finally {
      barrier.resume();
      await Promise.allSettled([...corpus.work, syncing, closing]);
      barrier.restore();
      corpus.restore();
    }
  });
});
