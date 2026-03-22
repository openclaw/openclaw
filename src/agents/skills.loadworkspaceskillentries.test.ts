import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { loadWorkspaceSkillEntries } from "./skills.js";
import { writePluginWithSkill } from "./test-helpers/skill-plugin-fixtures.js";

const tempDirs: string[] = [];

async function createTempWorkspaceDir() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

async function symlinkDir(targetDir: string, linkPath: string) {
  await fs.symlink(targetDir, linkPath, process.platform === "win32" ? "junction" : "dir");
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function setupWorkspaceWithProsePlugin() {
  const workspaceDir = await createTempWorkspaceDir();
  const managedDir = path.join(workspaceDir, ".managed");
  const bundledDir = path.join(workspaceDir, ".bundled");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "open-prose");

  await writePluginWithSkill({
    pluginRoot,
    pluginId: "open-prose",
    skillId: "prose",
    skillDescription: "test",
  });

  return { workspaceDir, managedDir, bundledDir };
}

async function setupWorkspaceWithDiffsPlugin() {
  const workspaceDir = await createTempWorkspaceDir();
  const managedDir = path.join(workspaceDir, ".managed");
  const bundledDir = path.join(workspaceDir, ".bundled");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "diffs");

  await writePluginWithSkill({
    pluginRoot,
    pluginId: "diffs",
    skillId: "diffs",
    skillDescription: "test",
  });

  return { workspaceDir, managedDir, bundledDir };
}

describe("loadWorkspaceSkillEntries", () => {
  it("handles an empty managed skills dir without throwing", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    await fs.mkdir(managedDir, { recursive: true });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries).toEqual([]);
  });

  it("includes plugin-shipped skills when the plugin is enabled", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithProsePlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          entries: { "open-prose": { enabled: true } },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("prose");
  });

  it("excludes plugin-shipped skills when the plugin is not allowed", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithProsePlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          allow: ["something-else"],
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain("prose");
  });

  it("includes diffs plugin skill when the plugin is enabled", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithDiffsPlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          entries: { diffs: { enabled: true } },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("diffs");
  });

  it("excludes diffs plugin skill when the plugin is disabled", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithDiffsPlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          entries: { diffs: { enabled: false } },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain("diffs");
  });

  it("allows managed skill directories that resolve outside the managed root", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const outsideDir = await createTempWorkspaceDir();
    const externalSkillDir = path.join(outsideDir, "outside-skill");

    await writeSkill({
      dir: externalSkillDir,
      name: "outside-skill",
      description: "Outside managed root",
    });
    await fs.mkdir(managedDir, { recursive: true });
    await symlinkDir(externalSkillDir, path.join(managedDir, "outside-skill"));

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("outside-skill");
  });

  it("skips workspace skill directories that resolve outside the workspace root", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const outsideDir = await createTempWorkspaceDir();
    const escapedSkillDir = path.join(outsideDir, "outside-skill");
    await writeSkill({
      dir: escapedSkillDir,
      name: "outside-skill",
      description: "Outside",
    });
    await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
    await symlinkDir(escapedSkillDir, path.join(workspaceDir, "skills", "escaped-skill"));

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-skill");
  });

  it.runIf(process.platform !== "win32")(
    "skips workspace skill files that resolve outside the workspace root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const outsideDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: outsideDir,
        name: "outside-file-skill",
        description: "Outside file",
      });
      const skillDir = path.join(workspaceDir, "skills", "escaped-file");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.symlink(path.join(outsideDir, "SKILL.md"), path.join(skillDir, "SKILL.md"));

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-file-skill");
    },
  );

  it.runIf(process.platform !== "win32")(
    "skips managed skill files that resolve outside the managed skill root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const managedDir = path.join(workspaceDir, ".managed");
      const outsideDir = await createTempWorkspaceDir();
      const escapedTargetDir = path.join(outsideDir, "outside-file-skill");
      await writeSkill({
        dir: escapedTargetDir,
        name: "outside-file-skill",
        description: "Outside file",
      });

      const externalManagedSkillDir = path.join(outsideDir, "managed-skill");
      await writeSkill({
        dir: externalManagedSkillDir,
        name: "managed-skill",
        description: "Managed skill",
      });
      await fs.rm(path.join(externalManagedSkillDir, "SKILL.md"));
      await fs.symlink(
        path.join(escapedTargetDir, "SKILL.md"),
        path.join(externalManagedSkillDir, "SKILL.md"),
      );
      await fs.mkdir(managedDir, { recursive: true });
      await symlinkDir(externalManagedSkillDir, path.join(managedDir, "managed-skill"));

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: managedDir,
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-file-skill");
      expect(entries.map((entry) => entry.skill.name)).not.toContain("managed-skill");
    },
  );
});
