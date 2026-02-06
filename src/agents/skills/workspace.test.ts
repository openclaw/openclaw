import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  SKILLS_COPY_EXCLUDED,
  loadWorkspaceSkillEntries,
  syncSkillsToWorkspace,
} from "./workspace.js";

async function writeSkill(params: { dir: string; name: string; description: string }) {
  const { dir, name, description } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf-8",
  );
}

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-ws-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const dir of tempDirs) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  tempDirs.length = 0;
});

describe("loadWorkspaceSkillEntries", () => {
  it("excludes skill directories ending with .disabled", async () => {
    const workspaceDir = await makeTempDir();
    const managedDir = path.join(workspaceDir, ".managed");

    await writeSkill({
      dir: path.join(workspaceDir, "skills", "active-skill"),
      name: "active-skill",
      description: "An active skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "old-skill.disabled"),
      name: "old-skill",
      description: "A disabled skill",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    const names = entries.map((e) => e.skill.name);
    expect(names).toContain("active-skill");
    expect(names).not.toContain("old-skill");
  });
});

describe("syncSkillsToWorkspace", () => {
  it("excludes artifact directories from copied skills", async () => {
    const sourceDir = await makeTempDir();
    const targetDir = await makeTempDir();
    const managedDir = path.join(sourceDir, ".managed");

    // Write a skill with a venv and node_modules inside it
    const skillDir = path.join(sourceDir, "skills", "py-skill");
    await writeSkill({ dir: skillDir, name: "py-skill", description: "A Python skill" });
    await fs.mkdir(path.join(skillDir, "venv", "lib"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "venv", "lib", "site.py"), "# venv", "utf-8");
    await fs.mkdir(path.join(skillDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(path.join(skillDir, "node_modules", "pkg", "index.js"), "// nm", "utf-8");
    await fs.writeFile(path.join(skillDir, "helper.py"), "# helper", "utf-8");

    await syncSkillsToWorkspace({
      sourceWorkspaceDir: sourceDir,
      targetWorkspaceDir: targetDir,
      managedSkillsDir: managedDir,
      bundledSkillsDir: path.join(sourceDir, ".bundled"),
    });

    const copiedSkillDir = path.join(targetDir, "skills", "py-skill");

    // SKILL.md and helper.py should be copied
    const skillMd = await fs.stat(path.join(copiedSkillDir, "SKILL.md")).catch(() => null);
    expect(skillMd?.isFile()).toBe(true);
    const helper = await fs.stat(path.join(copiedSkillDir, "helper.py")).catch(() => null);
    expect(helper?.isFile()).toBe(true);

    // venv and node_modules should NOT be copied
    const venv = await fs.stat(path.join(copiedSkillDir, "venv")).catch(() => null);
    expect(venv).toBeNull();
    const nodeModules = await fs.stat(path.join(copiedSkillDir, "node_modules")).catch(() => null);
    expect(nodeModules).toBeNull();
  });
});

describe("SKILLS_COPY_EXCLUDED", () => {
  it("matches expected artifact paths", () => {
    const artifactPaths = [
      "/workspace/skills/s/venv/lib/python3.11/site.py",
      "/workspace/skills/s/.venv/bin/python",
      "/workspace/skills/s/__pycache__/mod.cpython-311.pyc",
      "/workspace/skills/s/node_modules/pkg/index.js",
      "/workspace/skills/s/dist/bundle.js",
      "/workspace/skills/s/build/output.jar",
      "/workspace/skills/s/target/classes/Main.class",
      "/workspace/skills/s/.gradle/caches/file.lock",
      "/workspace/skills/s/foo.egg-info/PKG-INFO",
      "/workspace/skills/s.disabled/SKILL.md",
    ];
    for (const p of artifactPaths) {
      expect(
        SKILLS_COPY_EXCLUDED.some((re) => re.test(p)),
        `expected excluded: ${p}`,
      ).toBe(true);
    }
  });

  it("does not match normal skill paths", () => {
    const normalPaths = [
      "/workspace/skills/s/SKILL.md",
      "/workspace/skills/s/src/main.py",
      "/workspace/skills/s/lib/helper.ts",
    ];
    for (const p of normalPaths) {
      expect(
        SKILLS_COPY_EXCLUDED.some((re) => re.test(p)),
        `expected NOT excluded: ${p}`,
      ).toBe(false);
    }
  });
});
