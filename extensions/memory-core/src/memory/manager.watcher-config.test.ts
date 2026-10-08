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
import { MemoryIndexManager } from "./manager.js";
import * as settling from "./watch-settle.js";

vi.mock("./watch-settle.js", async (original) => ({
  ...(await original<typeof import("./watch-settle.js")>()),
}));

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
  function config(): OpenClawConfig {
    return {
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
  }
  function observing(absolute: string) {
    const result = observer.observations.find((entry) =>
      entry.options.scopes.some(
        (scope) => path.resolve(entry.root.rootDir, scope.path) === absolute,
      ),
    );
    if (!result) {
      throw new Error("Missing observation for " + absolute);
    }
    return result;
  }

  it("keeps a newer selected-file dirty behind held settling before publishing the index", async () => {
    const file = path.join(state.workspaceDir, "memory", "note.md");
    await fs.writeFile(file, "Initial indexed text.");
    await configureMemoryCoreDreamingStateForTests(state.env);
    const cfg = config();
    const debounceMs = resolveMemorySearchConfig(cfg, "main")!.sync.watchDebounceMs;
    manager = await MemoryIndexManager.get({ cfg, agentId: "main" });
    if (!manager) {
      throw new Error("memory manager unavailable");
    }
    await manager.sync({ reason: "test-initial-index" });
    const indexPath = manager.status().dbPath;
    if (!indexPath) {
      throw new Error("memory index path unavailable");
    }
    const index = new DatabaseSync(indexPath, { readOnly: true });
    const rows = index.prepare(
      `SELECT path, text FROM ${MEMORY_INDEX_CHUNKS_TABLE} ORDER BY path, start_line`,
    );
    const initial = [{ path: "memory/note.md", text: "Initial indexed text." }];
    const entry = observing(path.join(state.workspaceDir, "memory"));
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
    const settle = settling.settleMemoryWatchEventPaths;
    const passes: Array<Promise<boolean>> = [];
    vi.spyOn(settling, "settleMemoryWatchEventPaths").mockImplementation((...args) => {
      const pass = settle(...args);
      passes.push(pass);
      return pass;
    });
    const sync = vi.spyOn(manager, "sync");
    const dirty = () =>
      entry.dirty([{ path: path.relative(entry.root.rootDir, file), type: "content" }]);
    vi.useFakeTimers();
    try {
      expect(manager.status().dirty).toBe(false);
      await fs.writeFile(file, "Intermediate write.");
      dirty();
      expect(manager.status().dirty).toBe(true);
      expect(sync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(debounceMs);
      await entered.promise;
      await fs.writeFile(file, "Newest settled indexed text.");
      dirty();
      await vi.advanceTimersByTimeAsync(50);
      expect(sync).not.toHaveBeenCalled();
      expect(rows.all()).toEqual(initial);

      // The old sample completes last. It must neither erase the newer event
      // nor publish the intermediate generation while the file is unsettled.
      release.resolve();
      await sampled[0]!.promise;
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(100);
      await expect(passes[0]).resolves.toBe(false);
      await vi.advanceTimersByTimeAsync(0);
      expect(sync).not.toHaveBeenCalled();
      expect(rows.all()).toEqual(initial);

      await vi.advanceTimersByTimeAsync(debounceMs);
      await sampled[2]!.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(sync).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(100);
      await expect(passes[1]).resolves.toBe(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(sync).toHaveBeenCalledExactlyOnceWith({ reason: "watch" });
      await sync.mock.results[0]!.value;
      expect(rows.all()).toEqual([
        { path: "memory/note.md", text: "Newest settled indexed text." },
      ]);
      expect(sample).toBe(4);
    } finally {
      release.resolve();
      await manager.close();
      index.close();
    }
  });

  it("refreshes every search after watch-limit without further notifications", async () => {
    const file = path.join(state.workspaceDir, "memory", "note.md");
    await fs.writeFile(file, "Amber lantern baseline.");
    await configureMemoryCoreDreamingStateForTests(state.env);
    manager = await MemoryIndexManager.get({ cfg: config(), agentId: "main" });
    if (!manager) {
      throw new Error("memory manager unavailable");
    }
    await manager.sync({ reason: "initial" });
    observer.observations[0]!.health({ state: "ready", mode: "poll" });
    expect(manager.status().custom?.watcher).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ mode: "poll", pollingFallback: true, pollIntervalMs: 30_000 }),
      ]),
    );
    vi.useFakeTimers();
    observer.observations[0]!.health({
      state: "unavailable",
      failure: { operation: "watch", code: "watch-limit", error: new Error("watch limit") },
    });
    const lifecycle = manager as unknown as { awaitManagerIdle: () => Promise<void> };
    for (const text of ["Cobalt heron discovered.", "Violet badger replaced it."]) {
      await fs.writeFile(file, text);
      // Search schedules maintenance while serving its captured published generation.
      await manager.search(text, { minScore: 0 });
      await lifecycle.awaitManagerIdle();
      expect(
        (await manager.search(text, { minScore: 0 })).map((result) => result.snippet),
      ).toContain(text);
      await lifecycle.awaitManagerIdle();
    }
    expect(await manager.search("Cobalt heron", { minScore: 0 })).toEqual([]);
  });
});
