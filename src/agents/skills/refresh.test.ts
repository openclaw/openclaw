import { describe, expect, it, vi } from "vitest";

const watchMock = vi.fn(() => ({
  on: vi.fn(),
  close: vi.fn(async () => undefined),
}));

vi.mock("chokidar", () => {
  return {
    default: { watch: watchMock },
  };
});

describe("ensureSkillsWatcher", () => {
  it("ignores node_modules, dist, and .git by default", async () => {
    const mod = await import("./refresh.js");
    mod.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    expect(watchMock).toHaveBeenCalledTimes(1);
    const opts = watchMock.mock.calls[0]?.[1] as { ignored?: unknown };

    expect(opts.ignored).toBe(mod.DEFAULT_SKILLS_WATCH_IGNORED);
    const ignored = mod.DEFAULT_SKILLS_WATCH_IGNORED;
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/node_modules/pkg/index.js"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/dist/index.js"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.git/config"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/.hidden/skills/index.md"))).toBe(false);
  });

  it("ignores Python artifact directories", async () => {
    const { DEFAULT_SKILLS_WATCH_IGNORED: ignored } = await import("./refresh.js");
    const pythonPaths = [
      "/workspace/skills/my-skill/venv/lib/python3.11/site.py",
      "/workspace/skills/my-skill/.venv/bin/python",
      "/workspace/skills/my-skill/__pycache__/mod.cpython-311.pyc",
      "/workspace/skills/my-skill/site-packages/requests/__init__.py",
      "/workspace/skills/my-skill/.tox/py311/lib/site.py",
      "/workspace/skills/my-skill/.mypy_cache/3.11/mod.meta.json",
      "/workspace/skills/my-skill/.pytest_cache/v/cache/lastfailed",
      "/workspace/skills/my-skill/.ruff_cache/content.json",
      "/workspace/skills/my-skill/__pypackages__/3.11/lib/pkg/mod.py",
      "/workspace/skills/my-skill/foo.egg-info/PKG-INFO",
    ];
    for (const p of pythonPaths) {
      expect(
        ignored.some((re) => re.test(p)),
        `expected ignored: ${p}`,
      ).toBe(true);
    }
  });

  it("ignores build artifact and other heavy directories", async () => {
    const { DEFAULT_SKILLS_WATCH_IGNORED: ignored } = await import("./refresh.js");
    const buildPaths = [
      "/workspace/skills/my-skill/build/output.jar",
      "/workspace/skills/my-skill/target/classes/Main.class",
      "/workspace/skills/my-skill/.gradle/caches/file.lock",
      "/workspace/skills/my-skill/.next/static/chunks/main.js",
    ];
    for (const p of buildPaths) {
      expect(
        ignored.some((re) => re.test(p)),
        `expected ignored: ${p}`,
      ).toBe(true);
    }
  });

  it("ignores .disabled skill directories", async () => {
    const { DEFAULT_SKILLS_WATCH_IGNORED: ignored } = await import("./refresh.js");
    expect(ignored.some((re) => re.test("/workspace/skills/my-skill.disabled/index.md"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/workspace/skills/my-skill.disabled/"))).toBe(true);
  });

  it("does not ignore normal skill file paths", async () => {
    const { DEFAULT_SKILLS_WATCH_IGNORED: ignored } = await import("./refresh.js");
    const normalPaths = [
      "/workspace/skills/my-skill/index.md",
      "/workspace/skills/my-skill/src/main.py",
      "/workspace/skills/my-skill/lib/helper.ts",
    ];
    for (const p of normalPaths) {
      expect(
        ignored.some((re) => re.test(p)),
        `expected NOT ignored: ${p}`,
      ).toBe(false);
    }
  });
});
