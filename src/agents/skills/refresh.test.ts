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
  it("ignores node_modules, dist, .git, and Python venvs by default", async () => {
    const mod = await import("./refresh.js");
    mod.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    expect(watchMock).toHaveBeenCalledTimes(1);
    const opts = watchMock.mock.calls[0]?.[1] as { ignored?: unknown };

    expect(opts.ignored).toBe(mod.DEFAULT_SKILLS_WATCH_IGNORED);
    const ignored = mod.DEFAULT_SKILLS_WATCH_IGNORED;
    // Node.js
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/node_modules/pkg/index.js"))).toBe(
      true,
    );
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/dist/index.js"))).toBe(true);
    // Git
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.git/config"))).toBe(true);
    // Python virtual environments (can cause spawn EBADF on macOS)
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.venv/bin/python"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/venv/lib/python3.11"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.envs/myenv/bin"))).toBe(true);
    // Python caches
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/__pycache__/mod.pyc"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/.pytest_cache/v/cache"))).toBe(true);
    // Build outputs
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/build/lib/mod.js"))).toBe(true);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/coverage/lcov.info"))).toBe(true);
    // Should NOT ignore regular skill files
    expect(ignored.some((re) => re.test("/tmp/.hidden/skills/index.md"))).toBe(false);
    expect(ignored.some((re) => re.test("/tmp/workspace/skills/my-skill/SKILL.md"))).toBe(false);
  });
});
