import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import {
  resolveMemorySearchConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { MEMORY_INDEX_CHUNKS_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { MemoryIndexManager } from "./manager.js";

// Keep owner fault injection in this process; real worker transport has separate coverage.
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

describe("Memory watch configuration", () => {
  let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
  let manager: MemoryIndexManager | null = null;
  beforeEach(async () => {
    observer.reset();
    vi.stubEnv("CHOKIDAR_USEPOLLING", "false");
    vi.stubEnv("CHOKIDAR_INTERVAL", undefined);
    state = await createOpenClawTestState({ label: "memory-watch-config" });
    await fs.mkdir(path.join(state.workspaceDir, "memory"));
    await fs.mkdir(state.path("extra"));
  });
  afterEach(async () => {
    await manager?.close();
    manager = null;
    vi.restoreAllMocks();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    resetMemoryCoreDreamingStateForTests();
    await state.cleanup();
  });
  async function openManager(text: string) {
    const file = path.join(state.workspaceDir, "memory", "note.md");
    await fs.writeFile(file, text);
    await configureMemoryCoreDreamingStateForTests(state.env);
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      memory: {
        search: {
          provider: "none",
          sources: ["memory"],
          store: { vector: { enabled: false } },
          extraPaths: [state.path("extra")],
        },
      },
    };
    manager = await MemoryIndexManager.get({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg,
      agentId: "main",
    });
    if (!manager) {
      throw new Error("memory manager unavailable");
    }
    await manager.sync({ reason: "initial" });
    const lifecycle = manager as unknown as { awaitManagerIdle: () => Promise<void> };
    return { file, cfg, active: manager, idle: () => lifecycle.awaitManagerIdle() };
  }
  const snippets = async (active: MemoryIndexManager, text: string) =>
    (await active.search(text, { minScore: 0 })).map((result) => result.snippet);

  it("keeps a newer selected-file dirty behind held settling before publishing the index", async () => {
    const { file, cfg, active } = await openManager("Initial indexed text.");
    const debounceMs = resolveMemorySearchConfig(cfg, "main")!.sync.watchDebounceMs;
    const indexPath = active.status().dbPath;
    if (!indexPath) {
      throw new Error("memory index path unavailable");
    }
    const index = new DatabaseSync(indexPath, { readOnly: true });
    const rows = index.prepare(
      `SELECT path, text FROM ${MEMORY_INDEX_CHUNKS_TABLE} ORDER BY path, start_line`,
    );
    const initial = [{ path: "memory/note.md", text: "Initial indexed text." }];
    const entry = observer.observations.find(({ root, options }) =>
      options.scopes.some(
        (scope) =>
          path.resolve(root.rootDir, scope.path) === path.join(state.workspaceDir, "memory"),
      ),
    );
    if (!entry) {
      throw new Error("Missing memory observation");
    }
    const entered = createDeferred<void>();
    const release = createDeferred<void>();
    const sampled = Array.from({ length: 4 }, () => createDeferred<void>());
    const open = entry.root.open.bind(entry.root);
    let sample = 0;
    vi.spyOn(entry.root, "open").mockImplementation(async (...args) => {
      const opened = await open(...args);
      const current = sample++;
      const dispose = opened[Symbol.asyncDispose].bind(opened);
      vi.spyOn(opened, Symbol.asyncDispose).mockImplementation(async () => {
        await dispose();
        sampled[current]?.resolve();
      });
      if (current === 0) {
        entered.resolve();
        await release.promise;
      }
      return opened;
    });
    const sync = vi.spyOn(active, "sync");
    const dirty = () =>
      entry.dirty([{ path: path.relative(entry.root.rootDir, file), type: "content" }]);
    vi.useFakeTimers();
    try {
      expect(active.status().dirty).toBe(false);
      await fs.writeFile(file, "Intermediate write.");
      dirty();
      expect(active.status().dirty).toBe(true);
      expect(sync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(debounceMs);
      await entered.promise;
      await fs.writeFile(file, "Newest settled indexed text.");
      dirty();
      await vi.advanceTimersByTimeAsync(50);
      expect(sync).not.toHaveBeenCalled();
      expect(rows.all()).toEqual(initial);

      // An old sample cannot erase a newer event or publish an unsettled generation.
      release.resolve();
      await sampled[0]!.promise;
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await sampled[1]!.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(sync).not.toHaveBeenCalled();
      expect(rows.all()).toEqual(initial);

      await vi.advanceTimersByTimeAsync(debounceMs);
      await sampled[2]!.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(sync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      await sampled[3]!.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(sync).toHaveBeenCalledExactlyOnceWith({ reason: "watch" });
      await sync.mock.results[0]!.value;
      expect(rows.all()).toEqual([
        { path: "memory/note.md", text: "Newest settled indexed text." },
      ]);
      expect(sample).toBe(4);
    } finally {
      release.resolve();
      await active.close();
      index.close();
    }
  });

  it("refreshes every search after watch-limit without further notifications", async () => {
    const { file, active, idle } = await openManager("Amber lantern baseline.");
    vi.useFakeTimers();
    observer.observations[0]!.health({
      state: "unavailable",
      failure: { operation: "watch", code: "watch-limit", error: new Error("watch limit") },
    });
    for (const text of ["Cobalt heron discovered.", "Violet badger replaced it."]) {
      await fs.writeFile(file, text);
      // Search schedules maintenance while serving its captured published generation.
      await active.search(text, { minScore: 0 });
      await idle();
      expect(await snippets(active, text)).toContain(text);
      await idle();
    }
    expect(await active.search("Cobalt heron", { minScore: 0 })).toEqual([]);
  });

  it("stops refreshing clean searches after all observations recover", async () => {
    const { active, idle } = await openManager("Amber lantern.");
    const sync = vi.spyOn(MemoryIndexManager.prototype, "sync");
    const observationCount = observer.observations.length;
    vi.useFakeTimers();
    observer.observations[0]!.health({
      state: "unavailable",
      failure: { operation: "scan", code: "EIO", error: new Error("temporary scan failure") },
    });
    await active.search("Amber lantern", { minScore: 0 });
    await idle();
    expect(sync).toHaveBeenCalledWith({ reason: "search" });
    await vi.advanceTimersByTimeAsync(500);
    await vi.waitFor(() =>
      expect(active.status().custom?.watcher).toEqual(
        Array.from({ length: observationCount }, () => expect.objectContaining({ state: "ready" })),
      ),
    );
    await active.sync({ reason: "recovered" });
    await idle();
    sync.mockClear();
    expect(await snippets(active, "Amber lantern")).toContain("Amber lantern.");
    await idle();
    expect(sync).not.toHaveBeenCalled();
  });
});
