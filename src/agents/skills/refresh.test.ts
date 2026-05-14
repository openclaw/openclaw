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
const resolvePluginSkillDirsMock = vi.fn((): string[] => []);

let refreshModule: typeof import("./refresh.js");

function watchedTargets(callIndex: number): string[] {
  const calls = watchMock.mock.calls as unknown as Array<[string[], unknown]>;
  return calls[callIndex]?.[0] ?? [];
}

vi.mock("chokidar", () => ({
  default: { watch: watchMock },
}));

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillDirs: resolvePluginSkillDirsMock,
}));

describe("ensureSkillsWatcher", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
  });

  beforeEach(() => {
    watchMock.mockClear();
    resolvePluginSkillDirsMock.mockClear();
    createdWatchers.length = 0;
  });

  afterEach(async () => {
    vi.useRealTimers();
    await refreshModule.resetSkillsRefreshForTest();
  });

  it("watches skill roots and filters non-skill churn", () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    expect(watchMock).toHaveBeenCalledTimes(1);
    const firstCall = (
      watchMock.mock.calls as unknown as Array<[string[], { depth?: number; ignored?: unknown }]>
    )[0];
    const targets = firstCall?.[0] ?? [];
    const opts = firstCall?.[1] ?? {};

    expect(opts.ignored).toBe(refreshModule.shouldIgnoreSkillsWatchPath);
    expect(opts.depth).toBe(2);
    const posix = (p: string) => p.replaceAll("\\", "/");
    expect(targets).toContain(posix(path.join("/tmp/workspace", "skills")));
    expect(targets).toContain(posix(path.join("/tmp/workspace", ".agents", "skills")));
    expect(targets).toContain(posix(path.join(os.homedir(), ".agents", "skills")));
    const wildcardTargets = targets.filter((target) => target.includes("*"));
    expect(wildcardTargets).toStrictEqual([]);
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

  it("keeps grouped skill folders within the watcher traversal depth", async () => {
    vi.useFakeTimers();
    const seen: SkillsChangeEvent[] = [];
    refreshModule.registerSkillsChangeListener((change) => {
      seen.push(change);
    });
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace",
      config: { skills: { load: { watchDebounceMs: 10 } } },
    });

    const firstCall = (
      watchMock.mock.calls as unknown as Array<[string[], { depth?: number; ignored?: unknown }]>
    )[0];
    expect(firstCall?.[1]?.depth).toBe(2);

    createdWatchers[0]?.emit("change", "/tmp/workspace/skills/group/demo/SKILL.md");
    await vi.advanceTimersByTimeAsync(10);

    expect(seen).toEqual([
      {
        workspaceDir: "/tmp/workspace",
        reason: "watch",
        changedPath: "/tmp/workspace/skills/group/demo/SKILL.md",
      },
    ]);
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

  it("reuses existing watcher on subsequent calls with same workspaceDir", () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });
    expect(watchMock).toHaveBeenCalledTimes(1);

    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });
    expect(watchMock).toHaveBeenCalledTimes(1);
  });

  it("creates separate watchers for different workspaces", () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });
    expect(watchMock).toHaveBeenCalledTimes(1);

    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/other" });
    expect(watchMock).toHaveBeenCalledTimes(2);
  });

  it("reconfigures watcher when debounceMs changes", () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });
    expect(watchMock).toHaveBeenCalledTimes(1);

    // Same dir, same config — reuses watcher
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });
    expect(watchMock).toHaveBeenCalledTimes(1);

    // Same dir, different debounce — recreates watcher
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace",
      config: { skills: { load: { watchDebounceMs: 500 } } },
    });
    expect(watchMock).toHaveBeenCalledTimes(2);
  });

  it("reconfigures watcher when extraDirs change", () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });
    expect(watchMock).toHaveBeenCalledTimes(1);

    // Same dir, different extraDirs — recreates watcher
    refreshModule.ensureSkillsWatcher({
      workspaceDir: "/tmp/workspace",
      config: { skills: { load: { extraDirs: ["/extra/skills"] } } },
    });
    expect(watchMock).toHaveBeenCalledTimes(2);
  });

  it("reconfigures watcher when plugin skill dirs change", () => {
    resolvePluginSkillDirsMock
      .mockReturnValueOnce(["/tmp/plugin-a/skills"])
      .mockReturnValueOnce(["/tmp/plugin-b/skills"]);

    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });
    expect(watchMock).toHaveBeenCalledTimes(1);
    expect(watchedTargets(0)).toContain("/tmp/plugin-a/skills");

    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });
    expect(watchMock).toHaveBeenCalledTimes(2);
    expect(createdWatchers[0]?.close).toHaveBeenCalledTimes(1);
    expect(watchedTargets(1)).toContain("/tmp/plugin-b/skills");
  });
});
