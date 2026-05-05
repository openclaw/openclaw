import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillsChangeEvent } from "./refresh.js";

type WatchEvent = "add" | "change" | "unlink" | "unlinkDir" | "error";
type WatchCallback = (watchPath: string) => void;

function createMockWatcher() {
  const handlers = new Map<WatchEvent, WatchCallback[]>();
  const watcher = {
    on: vi.fn((event: WatchEvent, callback: WatchCallback) => {
      handlers.set(event, [...(handlers.get(event) ?? []), callback]);
      return watcher;
    }),
    close: vi.fn(async () => undefined),
    emit: (event: WatchEvent, watchPath: string) => {
      for (const callback of handlers.get(event) ?? []) {
        callback(watchPath);
      }
    },
  };
  return watcher;
}

const createdWatchers: Array<ReturnType<typeof createMockWatcher>> = [];
const watchMock = vi.fn(() => {
  const watcher = createMockWatcher();
  createdWatchers.push(watcher);
  return watcher;
});

let refreshModule: typeof import("./refresh.js");

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
}));

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillDirs: vi.fn(() => []),
}));

describe("ensureSkillsWatcher", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
  });

  beforeEach(() => {
    watchMock.mockClear();
    createdWatchers.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await refreshModule.resetSkillsRefreshForTest();
  });

  it("watches skill roots and filters non-skill churn", async () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    expect(watchMock).toHaveBeenCalledTimes(1);
    const firstCall = (
      watchMock.mock.calls as unknown as Array<[string[], { ignored?: unknown }]>
    )[0];
    const targets = firstCall?.[0] ?? [];
    const opts = firstCall?.[1] ?? {};

    expect(opts.ignored).toBe(refreshModule.shouldIgnoreSkillsWatchPath);
    const posix = (p: string) => p.replaceAll("\\", "/");
    expect(targets).toEqual(
      expect.arrayContaining([
        posix(path.join("/tmp/workspace", "skills")),
        posix(path.join("/tmp/workspace", ".agents", "skills")),
        posix(path.join(os.homedir(), ".agents", "skills")),
      ]),
    );
    expect(targets.every((target) => !target.includes("*"))).toBe(true);
    const ignored = refreshModule.shouldIgnoreSkillsWatchPath;

    // Node/JS paths
    expect(ignored("/tmp/workspace/skills/node_modules/pkg/index.js")).toBe(true);
    expect(ignored("/tmp/workspace/skills/dist/index.js")).toBe(true);
    expect(ignored("/tmp/workspace/skills/.git/config")).toBe(true);

    // Python virtual environments and caches
    expect(ignored("/tmp/workspace/skills/scripts/.venv/bin/python")).toBe(true);
    expect(ignored("/tmp/workspace/skills/venv/lib/python3.10/site.py")).toBe(true);
    expect(ignored("/tmp/workspace/skills/__pycache__/module.pyc")).toBe(true);
    expect(ignored("/tmp/workspace/skills/.mypy_cache/3.10/foo.json")).toBe(true);
    expect(ignored("/tmp/workspace/skills/.pytest_cache/v/cache")).toBe(true);

    // Build artifacts and caches
    expect(ignored("/tmp/workspace/skills/build/output.js")).toBe(true);
    expect(ignored("/tmp/workspace/skills/.cache/data.json")).toBe(true);

    // Should NOT ignore normal skill files
    expect(ignored("/tmp/.hidden/skills/index.md")).toBe(false);
    expect(ignored("/tmp/workspace/skills/my-skill", { isDirectory: () => true })).toBe(false);
    expect(ignored("/tmp/workspace/skills/my-skill/README.md", {})).toBe(true);
    expect(ignored("/tmp/workspace/skills/my-skill/SKILL.md", {})).toBe(false);
  });

  it.each(["add", "change", "unlink", "unlinkDir"] as const)(
    "refreshes skills snapshots on %s",
    async (event) => {
      vi.useFakeTimers();
      const seen: SkillsChangeEvent[] = [];
      refreshModule.registerSkillsChangeListener((change) => {
        seen.push(change);
      });
      refreshModule.ensureSkillsWatcher({
        workspaceDir: "/tmp/workspace",
        config: { skills: { load: { watchDebounceMs: 10 } } },
      });

      createdWatchers[0]?.emit(event, "/tmp/workspace/skills/demo/SKILL.md");
      await vi.advanceTimersByTimeAsync(10);

      expect(seen).toEqual([
        {
          workspaceDir: "/tmp/workspace",
          reason: "watch",
          changedPath: "/tmp/workspace/skills/demo/SKILL.md",
        },
      ]);
    },
  );

  it("clears the per-workspace snapshot version when the watcher is disabled", async () => {
    vi.useFakeTimers();
    const workspaceDir = "/tmp/workspace-version-leak";
    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });

    createdWatchers[0]?.emit("change", `${workspaceDir}/skills/demo/SKILL.md`);
    await vi.advanceTimersByTimeAsync(10);
    expect(refreshModule.getSkillsSnapshotVersion(workspaceDir)).toBeGreaterThan(0);

    refreshModule.ensureSkillsWatcher({
      workspaceDir,
      config: { skills: { load: { watch: false } } },
    });

    expect(refreshModule.getSkillsSnapshotVersion(workspaceDir)).toBe(0);
  });

  it("evicts idle watchers (>1h since last ensure) on subsequent ensure calls", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const idleWorkspaceDir = "/tmp/workspace-idle";
    refreshModule.ensureSkillsWatcher({
      workspaceDir: idleWorkspaceDir,
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });
    const idleWatcher = createdWatchers[0];
    createdWatchers[0]?.emit("change", `${idleWorkspaceDir}/skills/demo/SKILL.md`);
    await vi.advanceTimersByTimeAsync(10);
    expect(refreshModule.getSkillsSnapshotVersion(idleWorkspaceDir)).toBeGreaterThan(0);

    // Advance past the 1h idle TTL.
    vi.advanceTimersByTime(60 * 60_000 + 1_000);

    // A different workspace's ensure call drives the eviction sweep.
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace-active",
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });

    expect(idleWatcher?.close).toHaveBeenCalled();
    expect(refreshModule.getSkillsSnapshotVersion(idleWorkspaceDir)).toBe(0);
  });

  it("does not evict watchers refreshed within the idle TTL window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

    const activeWorkspaceDir = "/tmp/workspace-active-refresh";
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });
    const activeWatcher = createdWatchers[0];
    createdWatchers[0]?.emit("change", `${activeWorkspaceDir}/skills/demo/SKILL.md`);
    await vi.advanceTimersByTimeAsync(10);
    const firstVersion = refreshModule.getSkillsSnapshotVersion(activeWorkspaceDir);
    expect(firstVersion).toBeGreaterThan(0);

    // 30 minutes later (well within the 1h TTL), the same workspace re-ensures.
    vi.advanceTimersByTime(30 * 60_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: activeWorkspaceDir,
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });

    // 31 minutes later (61 total since the original ensure, but only 31 since
    // the refresh), another workspace's ensure runs the eviction sweep.
    vi.advanceTimersByTime(31 * 60_000);
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace-other",
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });

    expect(activeWatcher?.close).not.toHaveBeenCalled();
    expect(refreshModule.getSkillsSnapshotVersion(activeWorkspaceDir)).toBe(firstVersion);
  });
});
