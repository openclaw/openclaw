import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { CONFIG_DIR } from "../../utils.js";

const watchMock = vi.fn(() => ({
  on: vi.fn(),
  close: vi.fn(async () => undefined),
}));

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
  });

  afterEach(async () => {
    await refreshModule.resetSkillsRefreshForTest();
  });

  it("ignores node_modules, dist, .git, and Python venvs by default", async () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });

    expect(watchMock).toHaveBeenCalledTimes(1);
    const firstCall = (
      watchMock.mock.calls as unknown as Array<[string[], { ignored?: unknown; depth?: number }]>
    )[0];
    const targets = firstCall?.[0] ?? [];
    const opts = firstCall?.[1] ?? {};

    expect(opts.ignored).toBe(refreshModule.DEFAULT_SKILLS_WATCH_IGNORED);
    expect(opts.depth).toBe(2);
    expect(targets.every((t) => typeof t === "string" && !t.includes("*"))).toBe(true);
    expect(targets).toEqual(
      expect.arrayContaining([
        path.resolve("/tmp/workspace", "skills"),
        path.resolve("/tmp/workspace", ".agents", "skills"),
        path.resolve(CONFIG_DIR, "skills"),
        path.resolve(os.homedir(), ".agents", "skills"),
      ]),
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

  it("registers shallow directory watch handlers including unlinkDir", async () => {
    refreshModule.ensureSkillsWatcher({ workspaceDir: "/tmp/workspace" });
    const watcher = watchMock.mock.results[0]?.value as { on: ReturnType<typeof vi.fn> };
    const on = watcher?.on;
    expect(on).toHaveBeenCalledWith("unlinkDir", expect.any(Function));
    expect(on).toHaveBeenCalledWith("addDir", expect.any(Function));
  });
});

describe("shouldTriggerSkillsRefresh", () => {
  beforeAll(async () => {
    refreshModule = await import("./refresh.js");
  });

  const skillRoot = path.resolve("/ws/skills");
  const roots = [skillRoot];

  it("accepts change on root SKILL.md", () => {
    expect(
      refreshModule.shouldTriggerSkillsRefresh({
        event: "change",
        eventPath: path.join(skillRoot, "SKILL.md"),
        roots,
      }),
    ).toBe(true);
  });

  it("accepts unlink on nested SKILL.md", () => {
    expect(
      refreshModule.shouldTriggerSkillsRefresh({
        event: "unlink",
        eventPath: path.join(skillRoot, "demo-skill", "SKILL.md"),
        roots,
      }),
    ).toBe(true);
  });

  it("accepts unlinkDir for a skill directory (direct child of watch root)", () => {
    expect(
      refreshModule.shouldTriggerSkillsRefresh({
        event: "unlinkDir",
        eventPath: path.join(skillRoot, "demo-skill"),
        roots,
      }),
    ).toBe(true);
  });

  it("rejects unlinkDir for nested directories under a skill", () => {
    expect(
      refreshModule.shouldTriggerSkillsRefresh({
        event: "unlinkDir",
        eventPath: path.join(skillRoot, "demo-skill", "nested"),
        roots,
      }),
    ).toBe(false);
  });

  it("rejects non-SKILL.md files", () => {
    expect(
      refreshModule.shouldTriggerSkillsRefresh({
        event: "change",
        eventPath: path.join(skillRoot, "demo-skill", "README.md"),
        roots,
      }),
    ).toBe(false);
  });

  it("rejects SKILL.md deeper than one skill directory", () => {
    expect(
      refreshModule.shouldTriggerSkillsRefresh({
        event: "change",
        eventPath: path.join(skillRoot, "a", "b", "SKILL.md"),
        roots,
      }),
    ).toBe(false);
  });
});
