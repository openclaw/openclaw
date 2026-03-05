import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
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
    const firstCall = (
      watchMock.mock.calls as unknown as Array<[string[], { ignored?: unknown }]>
    )[0];
    const targets = firstCall?.[0] ?? [];
    const opts = firstCall?.[1] ?? {};

    expect(opts.ignored).toBe(mod.DEFAULT_SKILLS_WATCH_IGNORED);
    const posix = (p: string) => p.replaceAll("\\", "/");
    expect(targets).toEqual(
      expect.arrayContaining([
        posix(path.join("/tmp/workspace", "skills", "SKILL.md")),
        posix(path.join("/tmp/workspace", "skills", "*", "SKILL.md")),
        posix(path.join("/tmp/workspace", ".agents", "skills", "SKILL.md")),
        posix(path.join("/tmp/workspace", ".agents", "skills", "*", "SKILL.md")),
        posix(path.join(os.homedir(), ".agents", "skills", "SKILL.md")),
        posix(path.join(os.homedir(), ".agents", "skills", "*", "SKILL.md")),
      ]),
    );
    expect(targets.every((target) => target.includes("SKILL.md"))).toBe(true);
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

describe("resolveWatchTargets", () => {
  it("includes skills-index.json when indexFirst is enabled", async () => {
    const mod = await import("./refresh.js");
    const targets = mod.resolveWatchTargets("/tmp/workspace", {
      skills: {
        load: {
          indexFirst: true,
          extraDirs: ["/tmp/external-skills"],
        },
      },
    });

    const posix = (p: string) => p.replaceAll("\\", "/");
    expect(targets).toEqual(
      expect.arrayContaining([
        posix(path.join("/tmp/workspace", "skills", "skills-index.json")),
        posix(path.join("/tmp/workspace", ".agents", "skills", "skills-index.json")),
        posix(path.join("/tmp/external-skills", "skills-index.json")),
        posix(path.join(os.homedir(), ".agents", "skills", "skills-index.json")),
      ]),
    );
  });

  it("does not include skills-index.json by default", async () => {
    const mod = await import("./refresh.js");
    const targets = mod.resolveWatchTargets("/tmp/workspace");

    expect(targets.every((target) => !target.endsWith("/skills-index.json"))).toBe(true);
  });

  it("watches the nested skills root when discovery auto-detects one", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-watch-"));
    const nestedSkillsDir = path.join(rootDir, "skills", "nested-skill");
    await fs.mkdir(nestedSkillsDir, { recursive: true });
    await fs.writeFile(
      path.join(nestedSkillsDir, "SKILL.md"),
      "---\nname: nested\ndescription: test\n---\n",
      "utf-8",
    );

    try {
      const mod = await import("./refresh.js");
      const targets = mod.resolveWatchTargets("/tmp/workspace", {
        skills: {
          load: {
            indexFirst: true,
            extraDirs: [rootDir],
          },
        },
      });

      const posix = (p: string) => p.replaceAll("\\", "/");
      expect(targets).toEqual(
        expect.arrayContaining([
          posix(path.join(rootDir, "skills", "skills-index.json")),
          posix(path.join(rootDir, "skills", "*", "SKILL.md")),
        ]),
      );
      expect(targets).not.toContain(posix(path.join(rootDir, "skills-index.json")));
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });
});
