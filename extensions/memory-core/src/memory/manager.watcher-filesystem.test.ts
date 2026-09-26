import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as observation from "@openclaw/fs-safe/watch";
import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
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
import { MemoryIndexManager } from "./manager.js";

// Real observation and indexing; only the application-owned settling clock is advanced.
vi.mock("@openclaw/fs-safe/watch", async (original) => ({
  ...(await original<typeof import("@openclaw/fs-safe/watch")>()),
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
  const subscriptions: observation.WatchSubscription[] = [];
  const bootstrap = createDeferred<void>();
  const originalWatch = observation.watch;
  const observed = vi.spyOn(observation, "watch").mockImplementation((authority, options) => {
    contexts.push(turn.getStore());
    const subscription = originalWatch(authority, {
      ...options,
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
    await fs.writeFile(path.join(state.workspaceDir, "MEMORY.md"), "Evergreen sentinel.");
    await fs.writeFile(path.join(state.workspaceDir, "USER.md"), "User sentinel.");
    await fs.writeFile(note, "Amethyst sentinel.");
    const cfg: OpenClawConfig = {
      plugins: { enabled: false },
      agents: { defaults: { workspace: state.workspaceDir }, list: [{ id: "main" }] },
      memory: {
        search: {
          provider: "none",
          sources: ["memory"],
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
    expect(contexts.every((context) => context === undefined)).toBe(true);
    await activeManager.close();
    expect(subscriptions.every((entry) => entry.health().state === "closed")).toBe(true);
    console.info(
      JSON.stringify({
        owner: "memory",
        platform: process.platform,
        modes: [...new Set(subscriptions.map((entry) => entry.health().mode))],
        root: "os.tmpdir",
        invalidation: "guarded-reconcile",
        proof: ["published-edit", "published-delete", "published-replacement", "joined-close"],
      }),
    );
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
