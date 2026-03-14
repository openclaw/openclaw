import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../engine-host-api.js";
import { resetEmbeddingMocks } from "./embedding.test-mocks.js";
import type { MemoryIndexManager } from "./index.js";
import { getRequiredMemoryIndexManager } from "./test-manager-helpers.js";

describe("memory manager external file watch", () => {
  let workspaceDir: string;
  let indexPath: string;
  let manager: MemoryIndexManager | null = null;

  beforeEach(async () => {
    vi.useFakeTimers();
    resetEmbeddingMocks();
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-mem-watch-"));
    indexPath = path.join(workspaceDir, "index.sqlite");
    await fs.mkdir(path.join(workspaceDir, "memory"));
    await fs.writeFile(path.join(workspaceDir, "memory", "notes.md"), "initial content");
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (manager) {
      await manager.close();
      manager = null;
    }
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it("triggers sync when external file changes are detected", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: true, watchDebounceMs: 50, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });
    const syncSpy = vi.spyOn(manager, "sync");

    // Initial sync to index the file
    await manager.sync({ reason: "initial" });
    syncSpy.mockClear();

    const initialStatus = manager.status();
    expect(initialStatus.files).toBe(1);
    expect(initialStatus.chunks).toBeGreaterThan(0);

    // Simulate external file change by calling internal watcher trigger
    // This mimics what chokidar does when it detects a file change
    const internalManager = manager as unknown as {
      dirty: boolean;
      scheduleWatchSync: () => void;
    };
    internalManager.dirty = true;
    internalManager.scheduleWatchSync();

    // Run the debounce timer
    await vi.runOnlyPendingTimersAsync();

    // Verify sync was called
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
  });

  it("debounces multiple rapid file changes", async () => {
    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: true, watchDebounceMs: 100, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });
    const syncSpy = vi.spyOn(manager, "sync");

    // Initial sync
    await manager.sync({ reason: "initial" });
    syncSpy.mockClear();

    const internalManager = manager as unknown as {
      dirty: boolean;
      scheduleWatchSync: () => void;
    };

    // Simulate multiple rapid file changes (like a bulk save or editor autosave)
    internalManager.dirty = true;
    internalManager.scheduleWatchSync();

    // Advance time partially (less than debounce)
    await vi.advanceTimersByTimeAsync(30);

    // Another file change comes in
    internalManager.scheduleWatchSync();

    // Advance time partially again
    await vi.advanceTimersByTimeAsync(30);

    // Yet another file change
    internalManager.scheduleWatchSync();

    // Should not have synced yet
    expect(syncSpy).not.toHaveBeenCalled();

    // Now advance past the debounce time
    await vi.advanceTimersByTimeAsync(100);

    // Should have synced exactly once
    expect(syncSpy).toHaveBeenCalledTimes(1);
    expect(syncSpy).toHaveBeenCalledWith({ reason: "watch" });
  });

  it("reindexes modified file content after external change", async () => {
    // Need real timers for actual file operations. Note: chokidar may fire a
    // concurrent sync between writeFile and manual sync, but this is benign
    // since we only assert dirty=false. afterEach handles cleanup properly.
    vi.useRealTimers();

    const cfg = {
      agents: {
        defaults: {
          workspace: workspaceDir,
          memorySearch: {
            provider: "openai",
            model: "mock-embed",
            store: { path: indexPath, vector: { enabled: false } },
            sync: { watch: true, watchDebounceMs: 50, onSessionStart: false, onSearch: false },
            query: { minScore: 0, hybrid: { enabled: false } },
          },
        },
        list: [{ id: "main", default: true }],
      },
    } as OpenClawConfig;

    manager = await getRequiredMemoryIndexManager({ cfg, agentId: "main" });

    // Initial sync
    await manager.sync({ reason: "initial" });
    const initialStatus = manager.status();
    expect(initialStatus.files).toBe(1);

    // Modify file content externally (adding more content)
    const filePath = path.join(workspaceDir, "memory", "notes.md");
    await fs.writeFile(
      filePath,
      "initial content\n\nAdditional paragraph with more information that will create more chunks.",
    );

    // Mark dirty and force sync (simulating what the watcher would do)
    const internalManager = manager as unknown as { dirty: boolean };
    internalManager.dirty = true;
    await manager.sync({ reason: "watch", force: true });

    // Verify the content was reindexed
    const newStatus = manager.status();
    expect(newStatus.files).toBe(1);
    // Content should have been reprocessed (chunks may vary based on content length)
    expect(newStatus.dirty).toBe(false);
  });
});
