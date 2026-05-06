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
let previousPollingEnv: string | undefined;
let previousPollingIntervalEnv: string | undefined;

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
    previousPollingEnv = process.env.OPENCLAW_SKILLS_WATCH_POLLING;
    previousPollingIntervalEnv = process.env.OPENCLAW_SKILLS_WATCH_POLL_INTERVAL_MS;
    delete process.env.OPENCLAW_SKILLS_WATCH_POLLING;
    delete process.env.OPENCLAW_SKILLS_WATCH_POLL_INTERVAL_MS;
  });

  afterEach(async () => {
    if (previousPollingEnv === undefined) {
      delete process.env.OPENCLAW_SKILLS_WATCH_POLLING;
    } else {
      process.env.OPENCLAW_SKILLS_WATCH_POLLING = previousPollingEnv;
    }
    if (previousPollingIntervalEnv === undefined) {
      delete process.env.OPENCLAW_SKILLS_WATCH_POLL_INTERVAL_MS;
    } else {
      process.env.OPENCLAW_SKILLS_WATCH_POLL_INTERVAL_MS = previousPollingIntervalEnv;
    }
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

  it("enables chokidar polling when requested by env", async () => {
    process.env.OPENCLAW_SKILLS_WATCH_POLLING = "1";
    process.env.OPENCLAW_SKILLS_WATCH_POLL_INTERVAL_MS = "1200";

    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    const firstCall = (
      watchMock.mock.calls as unknown as Array<
        [
          string[],
          {
            usePolling?: boolean;
            interval?: number;
          },
        ]
      >
    )[0];
    const opts = firstCall?.[1] ?? {};

    expect(opts.usePolling).toBe(true);
    expect(opts.interval).toBe(1200);
  });

  it("ignores invalid polling interval env values", async () => {
    process.env.OPENCLAW_SKILLS_WATCH_POLLING = "1";
    process.env.OPENCLAW_SKILLS_WATCH_POLL_INTERVAL_MS = "not-a-number";

    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    const firstCall = (
      watchMock.mock.calls as unknown as Array<
        [
          string[],
          {
            usePolling?: boolean;
            interval?: number;
          },
        ]
      >
    )[0];
    const opts = firstCall?.[1] ?? {};

    expect(opts.usePolling).toBe(true);
    expect(opts.interval).toBeUndefined();
  });

  it("ignores polling interval env values that floor to zero", async () => {
    process.env.OPENCLAW_SKILLS_WATCH_POLLING = "1";
    process.env.OPENCLAW_SKILLS_WATCH_POLL_INTERVAL_MS = "0.5";

    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    const firstCall = (
      watchMock.mock.calls as unknown as Array<
        [
          string[],
          {
            usePolling?: boolean;
            interval?: number;
          },
        ]
      >
    )[0];
    const opts = firstCall?.[1] ?? {};

    expect(opts.usePolling).toBe(true);
    expect(opts.interval).toBeUndefined();
  });

  it("recreates the watcher when polling settings change", async () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });
    expect(watchMock).toHaveBeenCalledTimes(1);

    process.env.OPENCLAW_SKILLS_WATCH_POLLING = "1";
    process.env.OPENCLAW_SKILLS_WATCH_POLL_INTERVAL_MS = "1200";

    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    expect(watchMock).toHaveBeenCalledTimes(2);
    const secondCall = (
      watchMock.mock.calls as unknown as Array<
        [
          string[],
          {
            usePolling?: boolean;
            interval?: number;
          },
        ]
      >
    )[1];
    const opts = secondCall?.[1] ?? {};

    expect(opts.usePolling).toBe(true);
    expect(opts.interval).toBe(1200);
  });
});
