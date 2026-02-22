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

/**
 * Test a path against the ignored array which may contain RegExps and functions.
 */
function isIgnored(
  ignored: Array<RegExp | ((path: string) => boolean)>,
  filePath: string,
): boolean {
  return ignored.some((rule) =>
    typeof rule === "function" ? rule(filePath) : rule.test(filePath),
  );
}

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
    expect(isIgnored(ignored, "/tmp/workspace/skills/node_modules/pkg/index.js")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/dist/index.js")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/.git/config")).toBe(true);

    // Python virtual environments and caches
    expect(isIgnored(ignored, "/tmp/workspace/skills/scripts/.venv/bin/python")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/venv/lib/python3.10/site.py")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/__pycache__/module.pyc")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/.mypy_cache/3.10/foo.json")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/.pytest_cache/v/cache")).toBe(true);

    // Build artifacts and caches
    expect(isIgnored(ignored, "/tmp/workspace/skills/build/output.js")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/.cache/data.json")).toBe(true);

    // Should NOT ignore normal skill files
    expect(isIgnored(ignored, "/tmp/workspace/skills/my-skill/SKILL.md")).toBe(false);
    expect(isIgnored(ignored, "/tmp/workspace/skills/my-skill/index.js")).toBe(false);
    expect(isIgnored(ignored, "/tmp/workspace/skills/my-skill/config.json")).toBe(false);
    expect(isIgnored(ignored, "/tmp/workspace/skills/my-skill/script.py")).toBe(false);
    expect(isIgnored(ignored, "/tmp/workspace/skills/my-skill/run.sh")).toBe(false);
  });

  it("ignores non-relevant asset files to prevent FD exhaustion", async () => {
    const mod = await import("./refresh.js");
    const ignored = mod.DEFAULT_SKILLS_WATCH_IGNORED;

    // SVG icon packs, images, audio, video — should be ignored
    expect(isIgnored(ignored, "/tmp/workspace/skills/icons/icon-1.svg")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/icons/photo.png")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/icons/photo.jpg")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/icons/photo.jpeg")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/assets/clip.mp3")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/assets/clip.mp4")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/assets/font.woff2")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/assets/data.csv")).toBe(true);
    expect(isIgnored(ignored, "/tmp/workspace/skills/assets/archive.zip")).toBe(true);
  });
});
