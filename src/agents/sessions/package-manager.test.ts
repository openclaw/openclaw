import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "./package-manager.js";
import { SettingsManager } from "./settings-manager.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("DefaultPackageManager", () => {
  it("keeps manifest resource entries inside the package root", async () => {
    const root = await makeTempDir("openclaw-package-manager-");
    const packageRoot = join(root, "package");
    const outsideRoot = join(root, "outside");
    const insideSkill = join(packageRoot, "skills", "inside", "SKILL.md");
    const outsideSkill = join(outsideRoot, "SKILL.md");
    await mkdir(join(packageRoot, "skills", "inside"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(insideSkill, "# Inside\n", "utf-8");
    await writeFile(outsideSkill, "# Outside\n", "utf-8");

    const entries = ["skills/inside/SKILL.md", "../outside/SKILL.md", "../outside/*.md"];
    try {
      await symlink(outsideRoot, join(packageRoot, "skills", "linked"), "dir");
      entries.push("skills/linked/SKILL.md");
    } catch {
      // Some filesystems disallow directory symlinks; path traversal coverage is still enough there.
    }

    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ openclaw: { skills: entries } }),
      "utf-8",
    );

    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
    });

    const resolved = await manager.resolve();
    const skillPaths = resolved.skills.map((skill) => skill.path);

    expect(skillPaths).toContain(insideSkill);
    expect(skillPaths).not.toContain(outsideSkill);
  });

  it("keeps convention-discovered resource entries inside the package root", async () => {
    const root = await makeTempDir("openclaw-package-manager-");
    const packageRoot = join(root, "package");
    const outsideRoot = join(root, "outside");
    const insideSkill = join(packageRoot, "skills", "inside", "SKILL.md");
    await mkdir(join(packageRoot, "skills", "inside"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(insideSkill, "# Inside\n", "utf-8");
    await writeFile(join(outsideRoot, "SKILL.md"), "# Outside\n", "utf-8");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pkg" }), "utf-8");

    try {
      await symlink(outsideRoot, join(packageRoot, "skills", "linked"), "dir");
    } catch {
      // Some filesystems disallow directory symlinks; skip the symlink-only assertion there.
    }

    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
    });

    const resolved = await manager.resolve();
    const skillPaths = resolved.skills.map((skill) => skill.path);

    expect(skillPaths).toContain(insideSkill);
    expect(skillPaths.some((skillPath) => skillPath.includes(join("skills", "linked")))).toBe(
      false,
    );
  });

  it("does not auto-install missing npm package resources", async () => {
    const root = await makeTempDir("openclaw-package-manager-");
    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: ["npm:@openclaw/missing-test"] }),
    });

    const resolved = await manager.resolve();

    expect(resolved.extensions).toEqual([]);
    expect(resolved.skills).toEqual([]);
    expect(resolved.prompts).toEqual([]);
    expect(resolved.themes).toEqual([]);
  });
});
