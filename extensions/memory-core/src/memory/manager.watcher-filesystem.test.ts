import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import * as observation from "@openclaw/fs-safe/watch";
import {
  resolveMemorySearchConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { MEMORY_INDEX_CHUNKS_TABLE } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it, vi } from "vitest";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
} from "../test-helpers.js";
import { MemoryIndexManager } from "./manager.js";

// Copy the real installed ESM exports only to allow readiness/lifetime instrumentation.
vi.mock("@openclaw/fs-safe/watch", async (original) => ({
  ...(await original<typeof import("@openclaw/fs-safe/watch")>()),
}));

const nativeSupported =
  process.platform === "linux" &&
  process.release.name === "node" &&
  !process.versions.bun &&
  !process.versions.deno;

describe.each(["node", "poll"] as const)("memory %s watchers on the real filesystem", (mode) => {
  it.skipIf(mode === "node" && !nativeSupported).each(["replacement", "removal"] as const)(
    "keeps search fresh after root %s and releases watchers on close",
    async (operation) => {
      vi.stubEnv("CHOKIDAR_USEPOLLING", mode === "poll" ? "true" : "false");
      vi.stubEnv("CHOKIDAR_INTERVAL", "20");
      const state = await createOpenClawTestState({ label: "memory-watch-filesystem" });
      // Explicit workspace admission must survive an ignored-name ancestor.
      const workspaceDir = state.path("node_modules", "workspace");
      const subscriptions: observation.WatchSubscription[] = [];
      const turnContext = new AsyncLocalStorage<string>();
      const pendingInputContext = new AsyncLocalStorage<string>();
      const watcherContexts: Array<{ turn?: string; pendingInput?: string }> = [];
      const timerContexts: typeof watcherContexts = [];
      const originalWatch = observation.watch;
      const watchObserver = vi.spyOn(observation, "watch").mockImplementation((...args) => {
        watcherContexts.push({
          turn: turnContext.getStore(),
          pendingInput: pendingInputContext.getStore(),
        });
        expect(args[1].mode).toBe(mode);
        // Disable periodic repair only for the native proof. Polling must notice
        // later edits autonomously at the configured cadence, never reconcile().
        const subscription = originalWatch(
          args[0],
          mode === "node" ? { ...args[1], intervalMs: 2_147_483_647 } : args[1],
        );
        subscriptions.push(subscription);
        return subscription;
      });
      let debounceMs: number | undefined;
      const originalSetTimeout = globalThis.setTimeout;
      const timerObserver = vi.spyOn(globalThis, "setTimeout").mockImplementation((...args) => {
        // Observe the real domain debounce timers.
        if (args[1] === debounceMs) {
          timerContexts.push({
            turn: turnContext.getStore(),
            pendingInput: pendingInputContext.getStore(),
          });
        }
        return originalSetTimeout(...args);
      });
      let manager: MemoryIndexManager | null = null;
      let index: DatabaseSync | undefined;
      try {
        await fs.mkdir(workspaceDir, { recursive: true });
        await configureMemoryCoreDreamingStateForTests(state.env);
        const memoryDir = path.join(workspaceDir, "memory");
        await fs.mkdir(memoryDir);
        // Preserve an indexed file while the watched root is absent.
        await fs.writeFile(path.join(workspaceDir, "MEMORY.md"), "Evergreen sentinel.");
        await fs.writeFile(path.join(memoryDir, "old.md"), "Amethyst sentinel.");
        const cfg: OpenClawConfig = {
          plugins: { enabled: false },
          agents: { defaults: { workspace: workspaceDir }, list: [{ id: "main" }] },
          memory: {
            search: {
              provider: "none",
              sources: ["memory"],
              store: { vector: { enabled: false } },
              query: { minScore: 0 },
            },
          },
        };
        debounceMs = resolveMemorySearchConfig(cfg, "main")!.sync.watchDebounceMs;
        manager = await turnContext.run("opening turn", () =>
          pendingInputContext.run("accepted input", async () => {
            const opened = await MemoryIndexManager.get({ cfg, agentId: "main" });
            expect(turnContext.getStore()).toBe("opening turn");
            expect(pendingInputContext.getStore()).toBe("accepted input");
            return opened;
          }),
        );
        if (!manager) {
          throw new Error("memory manager unavailable");
        }
        const activeManager = manager;
        await activeManager.sync({ reason: "test-initial-index" });
        expect(activeManager.status().fts?.available).toBe(true);
        expect(subscriptions.length).toBeGreaterThan(0);
        await Promise.all(subscriptions.map((entry) => entry.ready));
        // Polling may already have begun its next scan after initial readiness.
        for (const entry of subscriptions) {
          expect(["ready", "reconciling"]).toContain(entry.health().state);
          expect(entry.health()).toMatchObject({ mode, workers: mode === "poll" ? 0 : 1 });
        }
        const indexPath = activeManager.status().dbPath;
        if (!indexPath) {
          throw new Error("memory index path unavailable");
        }
        index = new DatabaseSync(indexPath, { readOnly: true });
        const indexedRows = index.prepare(
          `SELECT path, text FROM ${MEMORY_INDEX_CHUNKS_TABLE} ORDER BY path, start_line`,
        );
        // Observe committed data without searching: search can synchronize dirty
        // or empty indexes itself and would conceal broken filesystem watchers.
        const expectIndexed = async (files: Array<{ path: string; text: string }>) => {
          await expect
            .poll(() => indexedRows.all(), { timeout: 15_000 })
            .toEqual([{ path: "MEMORY.md", text: "Evergreen sentinel." }, ...files]);
        };
        await expectIndexed([{ path: "memory/old.md", text: "Amethyst sentinel." }]);

        await fs.rename(memoryDir, state.path("previous-memory"));
        if (operation === "removal") {
          // Observe deletion before recreation; the parent must retain coverage
          // even after the dead root's native watchers have been closed.
          await expectIndexed([]);
        }
        await fs.mkdir(memoryDir);
        const fresh = { path: "memory/fresh.md", text: "Heliotrope sentinel." };
        await fs.writeFile(path.join(memoryDir, "fresh.md"), fresh.text);
        await expectIndexed([fresh]);

        const nestedDir = path.join(memoryDir, "nested");
        await fs.mkdir(nestedDir);
        const nested = { path: "memory/nested/note.md", text: "Juniper sentinel." };
        await fs.writeFile(path.join(nestedDir, "note.md"), nested.text);
        await expectIndexed([fresh, nested]);
        nested.text = "Cobalt sentinel.";
        await fs.writeFile(path.join(nestedDir, "note.md"), nested.text);
        await expectIndexed([fresh, nested]);
        await fs.rm(nestedDir, { recursive: true });
        await expectIndexed([fresh]);
        expect((await activeManager.search("Heliotrope")).map((result) => result.path)).toEqual([
          fresh.path,
        ]);
        expect(await activeManager.search("Amethyst")).toEqual([]);
        expect(await activeManager.search("Cobalt")).toEqual([]);
        expect(watcherContexts.length).toBeGreaterThan(0);
        expect(timerContexts.length).toBeGreaterThan(0);
        for (const context of [...watcherContexts, ...timerContexts]) {
          expect(context).toEqual({ turn: undefined, pendingInput: undefined });
        }

        index.close();
        index = undefined;
        await activeManager.close();
        // close() is the library's joined physical teardown contract, including
        // workers invisible to a main-thread FSEventWrap census.
        for (const entry of subscriptions) {
          expect(entry.health()).toMatchObject({ state: "closed", workers: 0, directories: 0 });
        }
      } finally {
        index?.close();
        await manager?.close();
        timerObserver.mockRestore();
        watchObserver.mockRestore();
        vi.unstubAllEnvs();
        resetMemoryCoreDreamingStateForTests();
        await state.cleanup();
      }
    },
    60_000,
  );
});
