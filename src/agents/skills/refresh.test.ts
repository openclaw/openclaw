import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const watchMock = vi.fn(() => ({
  on: vi.fn(),
  close: vi.fn(async () => undefined),
}));

let refreshModule: typeof import("./refresh.js");

async function loadFreshRefreshModuleForTest() {
  vi.resetModules();
  vi.doMock("chokidar", () => ({
    default: { watch: watchMock },
  }));
  refreshModule = await import("./refresh.js");
}

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillDirs: vi.fn(() => []),
}));

describe("ensureSkillsWatcher", () => {
  beforeEach(async () => {
    watchMock.mockClear();
    vi.useFakeTimers();
    await loadFreshRefreshModuleForTest();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await refreshModule.resetSkillsRefreshForTest();
  });

  it("watches skill roots directly and only accepts supported SKILL.md layouts", async () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    expect(watchMock).toHaveBeenCalledTimes(1);
    const firstCall = (
      watchMock.mock.calls as unknown as Array<
        [string[], { ignored?: unknown; depth?: unknown; awaitWriteFinish?: unknown }]
      >
    )[0];
    const targets = firstCall?.[0] ?? [];
    const opts = firstCall?.[1] ?? {};

    expect(typeof opts.ignored).toBe("function");
    expect(opts.depth).toBe(3);
    expect(targets).toEqual(
      expect.arrayContaining([
        path.resolve("/tmp/workspace", "skills"),
        path.resolve("/tmp/workspace", ".agents", "skills"),
        path.resolve(os.homedir(), ".agents", "skills"),
      ]),
    );
    const ignored = opts.ignored as (
      candidatePath: string,
      stats?: { isDirectory?: () => boolean },
    ) => boolean;

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

    // Supported skill file layouts
    expect(ignored("/tmp/workspace/skills/SKILL.md")).toBe(false);
    expect(ignored("/tmp/workspace/skills/my-skill/SKILL.md")).toBe(false);
    expect(ignored("/tmp/workspace/skills/coze/koze-retrieval/SKILL.md")).toBe(false);
    expect(ignored("/tmp/workspace/skills/bundle/skills/defuddle/SKILL.md")).toBe(false);

    // Allowed directories needed to reach supported layouts
    expect(ignored("/tmp/workspace/skills/coze", { isDirectory: () => true })).toBe(false);
    expect(ignored("/tmp/workspace/skills/coze/koze-retrieval", { isDirectory: () => true })).toBe(
      false,
    );
    expect(ignored("/tmp/workspace/skills/bundle/skills", { isDirectory: () => true })).toBe(false);
    expect(
      ignored("/tmp/workspace/skills/bundle/skills/defuddle", { isDirectory: () => true }),
    ).toBe(false);

    // Unrelated files and deeper trees stay ignored
    expect(ignored("/tmp/workspace/skills/my-skill/notes.md")).toBe(true);
    expect(ignored("/tmp/workspace/skills/coze/koze-retrieval/notes.md")).toBe(true);
    expect(
      ignored("/tmp/workspace/skills/coze/koze-retrieval/deep", { isDirectory: () => true }),
    ).toBe(true);
  });

  it("bumps the snapshot only for supported skill file changes", async () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });
    const watcher = watchMock.mock.results[0]?.value as
      | { on: ReturnType<typeof vi.fn> }
      | undefined;
    const onMock = watcher?.on;
    const changeHandler = onMock?.mock.calls.find((call) => call[0] === "change")?.[1] as
      | ((filePath: string) => void)
      | undefined;

    expect(changeHandler).toBeDefined();
    if (!changeHandler) {
      return;
    }

    const events: Array<{ reason: string; changedPath?: string }> = [];
    const dispose = refreshModule.registerSkillsChangeListener((event) => {
      events.push({ reason: event.reason, changedPath: event.changedPath });
    });

    try {
      changeHandler("/tmp/workspace/skills/coze/koze-retrieval/SKILL.md");
      vi.advanceTimersByTime(300);
      expect(events).toEqual([
        {
          reason: "watch",
          changedPath: "/tmp/workspace/skills/coze/koze-retrieval/SKILL.md",
        },
      ]);

      events.length = 0;

      changeHandler("/tmp/workspace/skills/bundle/skills/defuddle/SKILL.md");
      vi.advanceTimersByTime(300);
      expect(events).toEqual([
        {
          reason: "watch",
          changedPath: "/tmp/workspace/skills/bundle/skills/defuddle/SKILL.md",
        },
      ]);

      events.length = 0;

      changeHandler("/tmp/workspace/skills/coze/koze-retrieval/notes.md");
      vi.advanceTimersByTime(300);
      expect(events).toEqual([]);
    } finally {
      dispose();
    }
  });
});
