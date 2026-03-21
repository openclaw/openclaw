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

  it("loads repo-style nested skills from the managed skills root", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const repoDir = path.join(managedDir, "kepano-obsidian-skills");

    await writeSkill({
      dir: path.join(repoDir, "skills", "defuddle"),
      name: "defuddle",
      description: "Extract clean markdown",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("defuddle");
  });

  it("loads repo-style nested skills from the workspace skills root", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const bundledDir = path.join(workspaceDir, ".bundled");
    const managedDir = path.join(workspaceDir, ".managed");
    const repoDir = path.join(workspaceDir, "skills", "kepano-obsidian-skills");

    await writeSkill({
      dir: path.join(repoDir, "skills", "defuddle"),
      name: "defuddle",
      description: "Extract clean markdown",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("defuddle");
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

  it.runIf(process.platform !== "win32")(
    "skips workspace skill directories that resolve outside the workspace root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const outsideDir = await createTempWorkspaceDir();
      const escapedSkillDir = path.join(outsideDir, "outside-skill");
      await writeSkill({
        dir: escapedSkillDir,
        name: "outside-skill",
        description: "Outside",
      });
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      await fs.symlink(escapedSkillDir, path.join(workspaceDir, "skills", "escaped-skill"), "dir");

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-skill");
    },
  );

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
    "avoids recursive loops when repo-style nested skills symlink back to an already visited root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillsRoot = path.join(workspaceDir, "skills");
      const repoDir = path.join(skillsRoot, "loop-repo");

      await writeSkill({
        dir: path.join(skillsRoot, "real-skill"),
        name: "real-skill",
        description: "Real skill",
      });
      await fs.mkdir(repoDir, { recursive: true });
      await fs.symlink(skillsRoot, path.join(repoDir, "skills"), "dir");

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });

      expect(entries.map((entry) => entry.skill.name)).toContain("real-skill");
    },
  );
});
