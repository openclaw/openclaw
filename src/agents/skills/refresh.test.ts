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

  it("ignores Python virtual environments and cache directories", async () => {
    const mod = await import("./refresh.js");
    const ignored = mod.DEFAULT_SKILLS_WATCH_IGNORED;

    // Python virtual environments
    expect(
      ignored.some((re) => re.test("/tmp/workspace/skills/.venv/lib/python3.9/site-packages/")),
    ).toBe(true);
    expect(
      ignored.some((re) => re.test("/tmp/workspace/skills/venv/lib/python3.9/site-packages/")),
    ).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/env/bin/python"))).toBe(true);

    // Python cache directories
    expect(
      ignored.some((re) => re.test("/tmp/workspace/skills/__pycache__/module.cpython-39.pyc")),
    ).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.pytest_cache/"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.tox/py39/lib/"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/package.egg-info/PKG-INFO"))).toBe(
      true,
    );

    // Should not ignore files that just contain these names
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/my_venv_config.json"))).toBe(false);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/pytest.ini"))).toBe(false);
  });

  it("ignores build artifacts and cache directories", async () => {
    const mod = await import("./refresh.js");
    const ignored = mod.DEFAULT_SKILLS_WATCH_IGNORED;

    // Build artifacts
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/build/output.js"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.cache/data.json"))).toBe(true);

    // Should not ignore normal skill files
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/my-skill/build.md"))).toBe(false);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/my-skill/SKILL.md"))).toBe(false);
  });
});
