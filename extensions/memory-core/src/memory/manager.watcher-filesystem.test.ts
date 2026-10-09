import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import * as observation from "openclaw/plugin-sdk/file-access-runtime";
import type { WatchSubscription } from "openclaw/plugin-sdk/file-access-runtime";
import {
  resolveMemorySearchConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { MEMORY_INDEX_CHUNKS_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { MemoryFileWatcher } from "./file-watcher.js";
import { MemoryIndexManager } from "./manager.js";

vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
}));
vi.mock("openclaw/plugin-sdk/runtime-env", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  sleepWithAbort: async (_ms: number, signal?: AbortSignal) => signal?.throwIfAborted(),
}));

it("indexes real edits, deletion and root replacement, then joins every subscription", async () => {
  // This helper allocates beneath os.tmpdir(), independent of the checkout path.
  const state = await createOpenClawTestState({ label: "memory-watch-filesystem" });
  const turn = new AsyncLocalStorage<string>();
  const contexts: Array<string | undefined> = [];
  const subscriptions: WatchSubscription[] = [];
  const visited = new Set<string>();
  const bootstrap = createDeferred<void>();
  const originalWatch = observation.watch;
  // Drive guarded scans explicitly so native hints cannot race the frozen settling clock.
  const observed = vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    contexts.push(turn.getStore());
    const subscription = originalWatch(authority, {
      ...options,
      mode: "poll",
      pollIntervalMs: 2_147_483_647,
      exclude(entry) {
        visited.add(path.resolve(authority.rootDir, entry.path));
        return options.exclude?.(entry) ?? false;
      },
      onInvalidate(invalidation) {
        options.onInvalidate(invalidation);
        if (invalidation.reason === "reconcile" && !invalidation.changes) {
          bootstrap.resolve();
        }
      },
    });
    subscriptions.push(subscription);
    return subscription;
  });
  let manager: MemoryIndexManager | null = null;
  let index: DatabaseSync | undefined;
  try {
    await configureMemoryCoreDreamingStateForTests(state.env);
    const memory = path.join(state.workspaceDir, "memory");
    const note = path.join(memory, "note.md");
    await fs.mkdir(memory);
    const unrelated = path.join(state.workspaceDir, "unrelated", "nested");
    await fs.mkdir(unrelated, { recursive: true });
    await fs.writeFile(path.join(unrelated, "unwatched.md"), "Outside memory selections.");
    const imports = path.join(state.workspaceDir, "imports");
    await fs.mkdir(imports);
    await fs.writeFile(path.join(imports, "keep.md"), "Imported sentinel.");
    await fs.writeFile(path.join(imports, "skip.md"), "Excluded by configured pattern.");
    await fs.mkdir(state.path("linked-source"));
    await fs.writeFile(state.path("linked-source", "note.md"), "Excluded symbolic source.");
    await fs.symlink(state.path("linked-source"), path.join(memory, "linked"), "junction");
    await fs.writeFile(path.join(state.workspaceDir, "MEMORY.md"), "Evergreen sentinel.");
    await fs.writeFile(path.join(state.workspaceDir, "USER.md"), "User sentinel.");
    await fs.writeFile(note, "Amethyst sentinel.");
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: state.workspaceDir }, entries: { main: {} } },
      memory: {
        search: {
          provider: "none",
          sources: ["memory"],
          extraPaths: [{ path: imports, pattern: "keep.md" }],
          store: { vector: { enabled: false } },
        },
      },
    };
    const debounceMs = resolveMemorySearchConfig(cfg, "main")!.sync.watchDebounceMs;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    manager = await turn.run("opening turn", () =>
      MemoryIndexManager.get({ cfg, agentId: "main" }),
    );
    if (!manager) {
      throw new Error("memory manager unavailable");
    }
    expect(subscriptions.length).toBeGreaterThan(0);
    expect(subscriptions.every((subscription) => subscription.health().state === "ready")).toBe(
      true,
    );
    const activeManager = manager;
    await activeManager.sync({ reason: "initial" });
    const indexPath = manager.status().dbPath;
    if (!indexPath) {
      throw new Error("memory index path unavailable");
    }
    index = new DatabaseSync(indexPath, { readOnly: true });
    const rows = index.prepare(
      `SELECT path, text FROM ${MEMORY_INDEX_CHUNKS_TABLE} ORDER BY path, start_line`,
    );
    const expected = (files: Array<{ path: string; text: string }>) => [
      { path: "MEMORY.md", text: "Evergreen sentinel." },
      { path: "USER.md", text: "User sentinel." },
      { path: "imports/keep.md", text: "Imported sentinel." },
      ...files,
    ];
    expect(rows.all()).toEqual(expected([{ path: "memory/note.md", text: "Amethyst sentinel." }]));
    let indexed = createDeferred<void>();
    const sync = activeManager.sync.bind(activeManager);
    vi.spyOn(activeManager, "sync").mockImplementation(async (options) => {
      try {
        await sync(options);
        if (options?.reason === "watch") {
          indexed.resolve();
        }
      } catch (error) {
        indexed.reject(error);
        throw error;
      }
    });
    const flush = async (files: Array<{ path: string; text: string }>) => {
      indexed = createDeferred<void>();
      await Promise.all(
        subscriptions
          .filter((entry) => entry.health().state !== "closed")
          .map((entry) => entry.reconcile()),
      );
      await vi.advanceTimersByTimeAsync(debounceMs);
      await indexed.promise;
      // Read published rows directly: search could repair a broken watcher itself.
      expect(rows.all()).toEqual(expected(files));
    };
    // Join the actual bootstrap invalidation; an unchanged reconcile emits no callback.
    await bootstrap.promise;
    await vi.advanceTimersByTimeAsync(debounceMs);
    await indexed.promise;
    expect(rows.all()).toEqual(expected([{ path: "memory/note.md", text: "Amethyst sentinel." }]));
    await fs.writeFile(note, "Cobalt sentinel after edit.");
    await flush([{ path: "memory/note.md", text: "Cobalt sentinel after edit." }]);
    await fs.rm(note);
    await flush([]);
    await fs.rename(memory, state.path("previous-memory"));
    await fs.mkdir(memory);
    await fs.writeFile(path.join(memory, "replacement.md"), "Heliotrope replacement.");
    await flush([{ path: "memory/replacement.md", text: "Heliotrope replacement." }]);
    expect(visited.has(path.join(imports, "keep.md"))).toBe(true);
    expect(visited.has(note)).toBe(true);
    expect([...visited].some((file) => file.startsWith(unrelated + path.sep))).toBe(false);
    expect(visited.has(path.join(state.path("linked-source"), "note.md"))).toBe(false);
    expect(contexts.every((context) => context === undefined)).toBe(true);
    await activeManager.close();
    expect(subscriptions.every((entry) => entry.health().state === "closed")).toBe(true);
  } finally {
    await manager?.close();
    index?.close();
    observed.mockRestore();
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetMemoryCoreDreamingStateForTests();
    await state.cleanup();
  }
});

it("observes later edits beyond the default directory scan budget", async () => {
  const state = await createOpenClawTestState({ label: "memory-watch-large-tree" });
  const memory = path.join(state.workspaceDir, "memory");
  const note = path.join(memory, "4096", "note.md");
  const initial = createDeferred<void>();
  const edited = createDeferred<void>();
  const failures: unknown[] = [];
  const subscriptions: WatchSubscription[] = [];
  const originalWatch = observation.watch;
  const observed = vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    const subscription = originalWatch(authority, {
      ...options,
      onHealth(health) {
        if (health.state === "unavailable") {
          failures.push(health.failure?.error);
        }
        options.onHealth?.(health);
      },
    });
    subscriptions.push(subscription);
    return subscription;
  });
  const onUnavailable = vi.fn();
  let watcher: MemoryFileWatcher | undefined;
  try {
    vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
    vi.stubEnv("CHOKIDAR_INTERVAL", "30000");
    await fs.mkdir(memory);
    for (let offset = 0; offset < 4097; offset += 64) {
      await Promise.all(
        Array.from({ length: Math.min(64, 4097 - offset) }, (_, index) =>
          fs.mkdir(path.join(memory, String(offset + index))),
        ),
      );
    }
    await fs.writeFile(note, "Initial memory.");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    watcher = new MemoryFileWatcher({
      workspaceDir: state.workspaceDir,
      agentId: "main",
      settings: {
        extraPaths: [],
        multimodal: { enabled: false, modalities: [], maxFileBytes: 10485760 },
        sync: { watchDebounceMs: 0 },
      },
      onUnavailable,
      onChange: async () => {
        const text = await fs.readFile(note, "utf8");
        if (text === "Initial memory.") {
          initial.resolve();
        } else if (text === "Memory after the edit.") {
          edited.resolve();
        }
      },
    });
    await watcher.start();
    expect(failures).toEqual([]);
    expect(subscriptions.some((subscription) => subscription.health().directories > 4096)).toBe(
      true,
    );
    await vi.advanceTimersByTimeAsync(0);
    await initial.promise;
    await fs.writeFile(note, "Memory after the edit.");
    await Promise.all(subscriptions.map((subscription) => subscription.reconcile()));
    await vi.advanceTimersByTimeAsync(0);
    await edited.promise;
    expect(onUnavailable).not.toHaveBeenCalled();
    await watcher.close();
    expect(subscriptions.every((subscription) => subscription.health().state === "closed")).toBe(
      true,
    );
  } finally {
    await watcher?.close();
    observed.mockRestore();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    await state.cleanup();
  }
});
