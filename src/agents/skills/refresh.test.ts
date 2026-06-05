import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const watchers: Array<{ on: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = [];
const watchMock = vi.fn(() => {
  const watcher = {
    on: vi.fn(),
    close: vi.fn(async () => undefined),
  };
  watchers.push(watcher);
  return watcher;
});

let refreshModule: typeof import("./refresh.js");

async function loadFreshRefreshModuleForTest() {
  vi.resetModules();
  vi.doMock("chokidar", () => ({
    default: { watch: watchMock },
  }));
  refreshModule = await import("./refresh.js");
}

describe("ensureSkillsWatcher", () => {
  beforeEach(async () => {
    watchMock.mockClear();
    watchers.length = 0;
    await loadFreshRefreshModuleForTest();
  });

  afterEach(async () => {
    await refreshModule.resetSkillsRefreshForTest();
  });

  it("watches skill roots with depth 1 and ignores non-skill paths", async () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    expect(watchMock).toHaveBeenCalledTimes(1);
    const firstCall = (
      watchMock.mock.calls as unknown as Array<[string[], { ignored?: unknown }]>
    )[0];
    const targets = firstCall?.[0] ?? [];
    const opts = firstCall?.[1] ?? {};

    expect(opts.ignored).toBe(refreshModule.DEFAULT_SKILLS_WATCH_IGNORED);
    expect(opts.depth).toBe(1);
    const posix = (p: string) => p.replaceAll("\\", "/");
    expect(targets).toEqual(
      expect.arrayContaining([
        posix(path.join("/tmp/workspace", "skills")),
        posix(path.join("/tmp/workspace", ".agents", "skills")),
        posix(path.join(os.homedir(), ".agents", "skills")),
      ]),
    );
    expect(targets.every((target) => !target.includes("*") && !target.endsWith("SKILL.md"))).toBe(
      true,
    );
    const ignored = refreshModule.DEFAULT_SKILLS_WATCH_IGNORED;

    // Node/JS paths
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/node_modules/pkg/index.js"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/dist/index.js"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.git/config"))).toBe(true);

    // Python virtual environments and caches
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/scripts/.venv/bin/python"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/venv/lib/python3.10/site.py"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/__pycache__/module.pyc"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.mypy_cache/3.10/foo.json"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.pytest_cache/v/cache"))).toBe(true);

    // Build artifacts and caches
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/build/output.js"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.cache/data.json"))).toBe(true);

    // Should NOT ignore normal skill files
    expect(ignored.some((re) => re.test("/tmp/.hidden/skills/index.md"))).toBe(false);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/my-skill/SKILL.md"))).toBe(false);
  });

  it("only reacts to root or one-level-deep SKILL.md changes", async () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    const watcher = watchers[0];
    expect(watcher).toBeTruthy();

    const addHandler = watcher.on.mock.calls.find(([event]) => event === "add")?.[1] as
      | ((path: string) => void)
      | undefined;
    expect(addHandler).toBeTypeOf("function");

    const listener = vi.fn();
    refreshModule.registerSkillsChangeListener(listener);

    addHandler?.("/tmp/workspace/skills/my-skill/SKILL.md");
    addHandler?.("/tmp/workspace/skills/SKILL.md");
    addHandler?.("/tmp/workspace/skills/my-skill/docs/SKILL.md");
    addHandler?.("/tmp/workspace/skills/my-skill/README.md");

    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toMatchObject({
      workspaceDir: "/tmp/workspace",
      reason: "watch",
      changedPath: "/tmp/workspace/skills/SKILL.md",
    });
  });
});
