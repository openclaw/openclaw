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
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { runInMemoryTestBackgroundContext } from "./background-context.test-support.js";
import { MemoryFileWatcher } from "./file-watcher.js";
import { MemoryIndexManager } from "./manager.js";

// Keep owner fault injection in this process; real worker transport has separate coverage.
vi.mock("./local-file-watcher.js", async (original) => {
  const watcher = await import("./file-watcher.js");
  return {
    ...(await original<typeof import("./local-file-watcher.js")>()),
    LocalMemoryFileWatcher: watcher.MemoryFileWatcher,
  };
});

vi.mock("openclaw/plugin-sdk/file-access-runtime", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/file-access-runtime")>()),
}));
vi.mock("openclaw/plugin-sdk/runtime-env", async (original) => ({
  ...(await original<typeof import("openclaw/plugin-sdk/runtime-env")>()),
  sleepWithAbort: async (_ms: number, signal?: AbortSignal) => signal?.throwIfAborted(),
}));

let state: Awaited<ReturnType<typeof createOpenClawTestState>>;
let owner: MemoryIndexManager | MemoryFileWatcher | null;
let index: DatabaseSync | undefined;
let subscriptions: WatchSubscription[];
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "memory-watch-filesystem" });
  owner = null;
  index = undefined;
  subscriptions = [];
});
afterEach(async () => {
  await owner?.close();
  index?.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  resetMemoryCoreDreamingStateForTests();
  await state.cleanup();
});
const expectClosed = () =>
  expect(subscriptions.every((entry) => entry.health().state === "closed")).toBe(true);
async function seedFiles(files: Record<string, string>) {
  for (const [file, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, text);
  }
}

it("indexes real edits, deletion and root replacement, then joins every subscription", async () => {
  const turn = new AsyncLocalStorage<string>();
  const contexts: Array<string | undefined> = [];
  const visited = new Set<string>();
  const bootstrap = createDeferred<void>();
  const originalWatch = observation.watch;
  // Drive guarded scans explicitly so native hints cannot race the frozen settling clock.
  vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
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
  await configureMemoryCoreDreamingStateForTests(state.env);
  const memory = path.join(state.workspaceDir, "memory");
  const note = path.join(memory, "note.md");
  const unrelated = path.join(state.workspaceDir, "unrelated", "nested");
  const imports = path.join(state.workspaceDir, "imports");
  await seedFiles({
    [path.join(unrelated, "unwatched.md")]: "Outside memory selections.",
    [path.join(imports, "keep.md")]: "Imported sentinel.",
    [path.join(imports, "skip.md")]: "Excluded by configured pattern.",
    [state.path("linked-source", "note.md")]: "Excluded symbolic source.",
    [path.join(state.workspaceDir, "MEMORY.md")]: "Evergreen sentinel.",
    [path.join(state.workspaceDir, "USER.md")]: "User sentinel.",
    [note]: "Amethyst sentinel.",
  });
  await fs.symlink(state.path("linked-source"), path.join(memory, "linked"), "junction");
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
  const manager = await turn.run("opening turn", () =>
    MemoryIndexManager.get({
      runInBackgroundContext: runInMemoryTestBackgroundContext,
      cfg,
      agentId: "main",
    }),
  );
  owner = manager;
  if (!manager) {
    throw new Error("memory manager unavailable");
  }
  expect(subscriptions.length).toBeGreaterThan(0);
  expect(subscriptions.every((subscription) => subscription.health().state === "ready")).toBe(true);
  await manager.sync({ reason: "initial" });
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
  const sync = manager.sync.bind(manager);
  vi.spyOn(manager, "sync").mockImplementation(async (options) => {
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
  await manager.close();
  expectClosed();
});

it("observes later edits beyond the default directory scan budget", async () => {
  const memory = path.join(state.workspaceDir, "memory");
  const note = path.join(memory, "4096", "note.md");
  const initial = createDeferred<void>();
  const edited = createDeferred<void>();
  const originalWatch = observation.watch;
  vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    const subscription = originalWatch(authority, options);
    subscriptions.push(subscription);
    return subscription;
  });
  const onUnavailable = vi.fn();
  vi.stubEnv("CHOKIDAR_USEPOLLING", "true");
  vi.stubEnv("CHOKIDAR_INTERVAL", "30000");
  await fs.mkdir(memory);
  for (let offset = 0; offset < 4097; offset += 64) {
    await Promise.all(
      Array.from({ length: Math.min(64, 4097 - offset) }, (_, entry) =>
        fs.mkdir(path.join(memory, String(offset + entry))),
      ),
    );
  }
  await fs.writeFile(note, "Initial memory.");
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const watcher = new MemoryFileWatcher({
    runInBackgroundContext: AsyncLocalStorage.snapshot(),
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
  owner = watcher;
  await watcher.start();
  expect(subscriptions.some((subscription) => subscription.health().directories > 4096)).toBe(true);
  await vi.advanceTimersByTimeAsync(0);
  await initial.promise;
  await fs.writeFile(note, "Memory after the edit.");
  await Promise.all(subscriptions.map((subscription) => subscription.reconcile()));
  await vi.advanceTimersByTimeAsync(0);
  await edited.promise;
  expect(onUnavailable).not.toHaveBeenCalled();
  await watcher.close();
  expectClosed();
});
