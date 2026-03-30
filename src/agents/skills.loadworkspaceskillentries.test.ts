import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { loadWorkspaceSkillEntries } from "./skills.js";
import { readSkillFrontmatterSafe } from "./skills/local-loader.js";
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

  it("falls back to the skill directory name when frontmatter omits name", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "fallback-name");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "description: Skill without explicit name", "---", "", "# Fallback"].join("\n"),
      "utf8",
    );

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("fallback-name");
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
    "skips symlinked SKILL.md even when the target stays inside the workspace root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const targetDir = path.join(workspaceDir, "safe-target");
      await writeSkill({
        dir: targetDir,
        name: "symlink-target",
        description: "Target skill",
      });

      const skillDir = path.join(workspaceDir, "skills", "symlinked");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.symlink(path.join(targetDir, "SKILL.md"), path.join(skillDir, "SKILL.md"));

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("symlink-target");
    },
  );

  it.runIf(process.platform !== "win32")(
    "reads skill frontmatter when the allowed root is the filesystem root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillDir = path.join(workspaceDir, "skills", "root-allowed");
      await writeSkill({
        dir: skillDir,
        name: "root-allowed",
        description: "Readable from filesystem root",
      });

      const frontmatter = readSkillFrontmatterSafe({
        rootDir: path.parse(skillDir).root,
        filePath: path.join(skillDir, "SKILL.md"),
      });

      expect(frontmatter).toMatchObject({
        name: "root-allowed",
        description: "Readable from filesystem root",
      });
    },
  );
});
