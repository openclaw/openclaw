import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

type WatcherHandler = (p: string) => void;

const watchMock = vi.fn(() => {
  const handlers = new Map<string, WatcherHandler>();
  return {
    on: vi.fn((event: string, handler: WatcherHandler) => {
      handlers.set(event, handler);
    }),
    close: vi.fn(async () => undefined),
    _handlers: handlers,
  };
});

vi.mock("chokidar", () => {
  return {
    default: { watch: watchMock },
  };
});

describe("ensureSkillsWatcher", () => {
  it("watches skill root directories directly (not globs) and ignores common dirs", async () => {
    const mod = await import("./refresh.js");
    mod.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    expect(watchMock).toHaveBeenCalledTimes(1);
    const firstCall = (
      watchMock.mock.calls as unknown as Array<[string[], { ignored?: unknown; depth?: number }]>
    )[0];
    const targets = firstCall?.[0] ?? [];
    const opts = firstCall?.[1] ?? {};

    // Should watch root directories directly, not glob patterns
    for (const target of targets) {
      expect(target).not.toContain("*");
      expect(target).not.toContain("SKILL.md");
    }

    // Should include the expected skill root directories
    expect(targets).toEqual(
      expect.arrayContaining([
        path.join("/tmp/workspace", "skills"),
        path.join("/tmp/workspace", ".agents", "skills"),
        path.join(os.homedir(), ".agents", "skills"),
      ]),
    );

    expect(opts.ignored).toBe(mod.DEFAULT_SKILLS_WATCH_IGNORED);
    // Depth should be limited to avoid deep traversal
    expect(opts.depth).toBe(1);

    const ignored = mod.DEFAULT_SKILLS_WATCH_IGNORED;

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
});

describe("isSkillPath", () => {
  it("accepts SKILL.md at root of a watch root", async () => {
    const { isSkillPath } = await import("./refresh.js");
    const roots = ["/workspace/skills", "/home/.agents/skills"];

    expect(isSkillPath("/workspace/skills/SKILL.md", roots)).toBe(true);
    expect(isSkillPath("/home/.agents/skills/SKILL.md", roots)).toBe(true);
  });

  it("accepts SKILL.md one level deep (standard layout)", async () => {
    const { isSkillPath } = await import("./refresh.js");
    const roots = ["/workspace/skills"];

    expect(isSkillPath("/workspace/skills/my-skill/SKILL.md", roots)).toBe(true);
  });

  it("rejects SKILL.md more than one level deep", async () => {
    const { isSkillPath } = await import("./refresh.js");
    const roots = ["/workspace/skills"];

    expect(isSkillPath("/workspace/skills/a/b/SKILL.md", roots)).toBe(false);
  });

  it("rejects non-SKILL.md files", async () => {
    const { isSkillPath } = await import("./refresh.js");
    const roots = ["/workspace/skills"];

    expect(isSkillPath("/workspace/skills/README.md", roots)).toBe(false);
    expect(isSkillPath("/workspace/skills/my-skill/index.ts", roots)).toBe(false);
    expect(isSkillPath("/workspace/skills/my-skill/SKILL.md.bak", roots)).toBe(false);
    expect(isSkillPath("/workspace/skills/my-skill/SKILL.md.old", roots)).toBe(false);
  });

  it("rejects paths outside any watch root", async () => {
    const { isSkillPath } = await import("./refresh.js");
    const roots = ["/workspace/skills"];

    expect(isSkillPath("/other/skills/SKILL.md", roots)).toBe(false);
  });

  it("schedule handler ignores non-SKILL.md events", async () => {
    const mod = await import("./refresh.js");
    // Reset watcher from previous test
    watchMock.mockClear();
    mod.ensureSkillsWatcher({ workspaceDir: "/tmp/ws-filter-test" });

    const mockWatcher = watchMock.mock.results[0]?.value as {
      _handlers: Map<string, WatcherHandler>;
    };
    const addHandler = mockWatcher._handlers.get("add");
    if (!addHandler) {
      throw new Error("add handler not registered");
    }

    const versionBefore = mod.getSkillsSnapshotVersion("/tmp/ws-filter-test");

    // Non-SKILL.md file should be filtered out — no version bump
    addHandler(path.join("/tmp/ws-filter-test", "skills", "my-skill", "index.ts"));

    // Wait for potential debounce
    await new Promise((resolve) => setTimeout(resolve, 350));
    expect(mod.getSkillsSnapshotVersion("/tmp/ws-filter-test")).toBe(versionBefore);
  });
});
