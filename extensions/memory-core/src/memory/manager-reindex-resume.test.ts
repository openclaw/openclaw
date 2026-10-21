import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { resolveSessionTranscriptsDirForAgent } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { publishSessionTranscriptUpdateByIdentity } from "openclaw/plugin-sdk/session-transcript-runtime";
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { MemoryIndexDatabase } from "./manager-database-context.js";
import { createManagerIndexFixture } from "./manager-index.test-support.js";

// mock-isolation: This suite drives watcher notifications instead of the fixture's silent observer.
vi.mock("./test-runtime-mocks.js", () => ({}));
vi.mock("./local-file-watcher.js", async (original) => {
  const { MemoryFileWatcher } = await import("./file-watcher.js");
  return {
    ...(await original<typeof import("./local-file-watcher.js")>()),
    LocalMemoryFileWatcher: MemoryFileWatcher,
  };
});
const observer = await vi.hoisted(async () => {
  const { createMemoryObservationHarness } = await import("./watcher-test-support.js");
  return createMemoryObservationHarness();
});
vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
  watch: observer.watch,
}));

const activity = vi.hoisted(() => ({
  listener: undefined as ((busy: boolean) => void) | undefined,
}));
vi.mock("openclaw/plugin-sdk/memory-core-host-engine-foundation", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/memory-core-host-engine-foundation")>();
  return {
    ...actual,
    observeAgentRunActivity: (_agentId: string, listener: (busy: boolean) => void) => {
      activity.listener = listener;
      listener(false);
      return () => {
        activity.listener = undefined;
      };
    },
  };
});

const { closeAllMemorySearchManagers, getMemorySearchManager } = await import("./index.js");

describe("background reindex resumption", () => {
  const fixture = createManagerIndexFixture({
    getMemorySearchManager,
    closeAllMemorySearchManagers,
  });
  beforeEach(() => observer.reset());
  afterEach(() => vi.restoreAllMocks());

  it.for([
    "idle",
    "watch",
    "bootstrap",
    "changed",
    "targeted",
    "close",
    "unsupported",
    "fallback",
  ] as const)(
    "settles a background reindex interrupted by a foreground turn: %s",
    { timeout: 30_000 },
    async (resume, { signal }) => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      onTestFinished(() => {
        vi.useRealTimers();
      });
      if (resume === "unsupported") {
        vi.spyOn(MemoryIndexDatabase.prototype, "supportsReindexSuspension", "get").mockReturnValue(
          false,
        );
      }
      const mixedSources = resume === "idle" || resume === "changed" || resume === "watch";
      const memoryPaths = mixedSources ? ["memory/2026-01-12.md", "memory/sibling.md"] : [];
      if (mixedSources) {
        await fs.writeFile(
          path.join(fixture.paths.memory, "sibling.md"),
          "Unchanged memory sibling.",
        );
      }
      const sessions = Array.from({ length: 17 }, (_, index) => ({
        sessionId: `resume-${String(index).padStart(2, "0")}`,
        sessionKey: `agent:main:chat:resume-${String(index).padStart(2, "0")}`,
      }));
      const suffix = resume === "targeted" ? ".jsonl.deleted.2026-10-01T00-00-00.000Z" : ".jsonl";
      const sessionPaths = sessions.map(({ sessionId }) => `sessions/main/${sessionId}${suffix}`);
      const sessionsDir = resolveSessionTranscriptsDirForAgent("main");
      const writeArchive = (file: string, content: string) =>
        fs.writeFile(
          file,
          JSON.stringify({ type: "message", message: { role: "user", content } }) + "\n",
        );
      if (resume === "targeted") {
        await fs.mkdir(sessionsDir, { recursive: true });
      }
      for (const session of sessions) {
        if (resume === "targeted") {
          await writeArchive(
            path.join(sessionsDir, `${session.sessionId}${suffix}`),
            "resumeproof alpha",
          );
        } else {
          await fixture.seedSessionTranscript({
            ...session,
            messages: [{ role: "user", timestamp: Date.now(), content: "resumeproof alpha" }],
          });
        }
      }
      const manager = await fixture.getFreshManager(
        fixture.createConfig({
          provider: mixedSources ? "batch-wide-test" : resume === "fallback" ? "openai" : "none",
          fallback: resume === "fallback" ? "fallback-provider" : undefined,
          batchEnabled: mixedSources,
          cacheEnabled: false,
          sources: mixedSources ? ["memory", "sessions"] : ["sessions"],
          sessionMemory: true,
          vectorEnabled: false,
        }),
      );
      onTestFinished(() => manager.close());
      const database = Reflect.get(manager, "db") as DatabaseSync;
      const idle = () =>
        (manager as unknown as { awaitManagerIdle(): Promise<void> }).awaitManagerIdle();
      const shadows = new Set<MemoryIndexDatabase>();
      const shadowPaths = new Set<string>();
      const groups: string[][] = [];
      const memoryWrites: string[] = [];
      let injectedFailures = 0;
      // Delegate every write: interruption follows a durably completed source group.
      // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted owner.
      const replace = MemoryIndexDatabase.prototype.replaceSource;
      vi.spyOn(MemoryIndexDatabase.prototype, "replaceSource").mockImplementation(async function (
        this: MemoryIndexDatabase,
        ...args
      ) {
        const result = await replace.apply(this, args);
        const input = args[0];
        const replacements = Array.isArray(input) ? input : [input];
        if (result === true && this.isShadow) {
          shadows.add(this);
          shadowPaths.add(this.db.location()!);
          memoryWrites.push(
            ...replacements
              .filter((item) => item.source === "memory")
              .map((item) => item.entry.path),
          );
          const sessionReplacements = replacements.filter((item) => item.source === "sessions");
          if (sessionReplacements.length > 0) {
            groups.push(sessionReplacements.map((item) => item.entry.path));
            if (groups.length === 1) {
              activity.listener?.(true);
            }
          }
        }
        return result;
      });
      const publishedChanges: unknown[] = [];
      // oxlint-disable-next-line typescript/unbound-method -- Called with the intercepted owner.
      const publishShadow = MemoryIndexDatabase.prototype.publishShadow;
      const publish = vi
        .spyOn(MemoryIndexDatabase.prototype, "publishShadow")
        .mockImplementation(async function (this: MemoryIndexDatabase, ...args) {
          await Reflect.apply(publishShadow, this, args);
          if (resume === "changed" || resume === "targeted") {
            // Observe the first publication before a later incremental pass could repair it.
            publishedChanges.push(
              database
                .prepare(
                  "SELECT path FROM memory_index_chunks_fts WHERE memory_index_chunks_fts MATCH ? ORDER BY path",
                )
                .all("changedwhilepaused OR memorychangedwhilepaused OR archivechangedwhilepaused"),
            );
          }
        });
      const release = () => activity.listener?.(false);
      const releaseOnAbort = () => {
        release();
        // A suspended stack may also be waiting for the quiet-period timer.
        vi.advanceTimersByTime(30_000);
      };
      signal.addEventListener("abort", releaseOnAbort, { once: true });
      try {
        await idle();
        if (resume === "watch") {
          await (manager as unknown as { memoryWatcherReady: Promise<void> }).memoryWatcherReady;
          // Start through the filesystem observation boundary before the session idle timer.
          observer.observations.at(-1)!.dirty();
          await vi.advanceTimersByTimeAsync(5_000);
        } else {
          await vi.advanceTimersByTimeAsync(30_000);
        }
        await idle();
        expect(groups).toHaveLength(1);
        expect(groups[0]).toHaveLength(8);
        expect(memoryWrites.toSorted()).toEqual(memoryPaths.toSorted());
        expect(publish).not.toHaveBeenCalled();
        expect(database.prepare("SELECT count(*) AS n FROM memory_index_sources").get()).toEqual({
          n: 0,
        });

        if (resume === "close") {
          expect(shadows.size).toBe(1);
          for (const shadow of shadows) {
            expect(shadow.isOpen).toBe(true);
            expect(shadow.shadowReleased).toBe(false);
          }
          for (const pathname of shadowPaths) {
            expect((await fs.stat(pathname)).isFile()).toBe(true);
          }
          await manager.close();
          expect(publish).not.toHaveBeenCalled();
          for (const shadow of shadows) {
            expect(shadow.shadowReleased).toBe(true);
          }
          for (const pathname of shadowPaths) {
            await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
          }
          return;
        }
        const expectedPaths = [...sessionPaths];
        const expectedMemoryWrites = [...memoryPaths];
        if (resume === "watch") {
          observer.observations.at(-1)!.dirty();
          await vi.advanceTimersByTimeAsync(5_000);
          await idle();
          expect(groups).toHaveLength(1);
          expect(publish).not.toHaveBeenCalled();
        }
        if (resume === "unsupported") {
          expect(shadows.size).toBe(1);
          for (const shadow of shadows) {
            expect(shadow.isOpen).toBe(false);
            expect(shadow.shadowReleased).toBe(true);
          }
          for (const pathname of shadowPaths) {
            await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
          }
          expectedPaths.push(...groups[0]!);
        }
        if (resume === "fallback") {
          fixture.provider.beforeEmbedBatch = async () => {
            injectedFailures += 1;
            fixture.provider.beforeEmbedBatch = null;
            throw fixture.provider.createLocalWorkerExitError();
          };
          expectedPaths.push(...groups[0]!);
        }
        if (resume === "changed") {
          const changedPath = groups[0]![0]!;
          const changedSession = sessions[sessionPaths.indexOf(changedPath)]!;
          expect(changedSession).toBeDefined();
          await fixture.seedSessionTranscript({
            ...changedSession,
            messages: [{ role: "user", timestamp: Date.now(), content: "changedwhilepaused" }],
          });
          await publishSessionTranscriptUpdateByIdentity({ agentId: "main", ...changedSession });
          expectedPaths.push(changedPath);
          await fs.writeFile(
            path.join(fixture.paths.workspace, memoryPaths[0]!),
            "Memorychangedwhilepaused replaces the original memory.",
          );
          (manager as unknown as { markMemoryWatchDirty(): void }).markMemoryWatchDirty();
          expectedMemoryWrites.push(memoryPaths[0]!);
        }
        if (resume === "targeted") {
          const sessionPath = groups[0]![0]!;
          const archivePath = groups[0]![1]!;
          const changedSession = sessions[sessionPaths.indexOf(sessionPath)]!;
          const sessionFile = path.join(sessionsDir, path.basename(sessionPath));
          const archiveFile = path.join(sessionsDir, path.basename(archivePath));
          await writeArchive(sessionFile, "changedwhilepaused");
          await writeArchive(archiveFile, "archivechangedwhilepaused");
          expectedPaths.push(sessionPath, archivePath);
          // Direct requests carry the change facts; no transcript notification repairs them.
          await manager.sync({
            reason: "targeted-resume",
            sessions: [{ sessionId: ` ${changedSession.sessionId} ` }],
            archiveFiles: [` ${path.relative(process.cwd(), archiveFile)} `],
          });
        } else if (resume === "bootstrap") {
          const hits = await manager.search("resumeproof", { lexicalOnly: true, signal });
          expect(hits.length).toBeGreaterThan(0);
        } else {
          release();
          await vi.advanceTimersByTimeAsync(30_000);
          await idle();
        }
        expect(shadows.size).toBe(resume === "unsupported" || resume === "fallback" ? 2 : 1);
        expect(publish).toHaveBeenCalledTimes(1);
        expect(groups.flat().toSorted()).toEqual(expectedPaths.toSorted());
        expect(memoryWrites.toSorted()).toEqual(expectedMemoryWrites.toSorted());
        if (resume === "idle") {
          expect(groups).toHaveLength(3);
        }
        expect(database.prepare("SELECT count(*) AS n FROM memory_index_sources").get()).toEqual({
          n: sessions.length + memoryPaths.length,
        });
        if (resume === "changed") {
          expect(publishedChanges).toEqual([[{ path: memoryPaths[0] }, { path: groups[0]![0] }]]);
        }
        if (resume === "targeted") {
          expect(publishedChanges).toEqual([
            groups[0]!
              .slice(0, 2)
              .toSorted()
              .map((pathname) => ({ path: pathname })),
          ]);
        }
        if (resume === "fallback") {
          expect(injectedFailures).toBe(1);
          expect(manager.status().provider).toBe("fallback-provider");
          for (const shadow of shadows) {
            expect(shadow.shadowReleased).toBe(true);
          }
          for (const pathname of shadowPaths) {
            await expect(fs.stat(pathname)).rejects.toMatchObject({ code: "ENOENT" });
          }
        }
      } finally {
        fixture.provider.beforeEmbedBatch = null;
        signal.removeEventListener("abort", releaseOnAbort);
        release();
      }
    },
  );
});
