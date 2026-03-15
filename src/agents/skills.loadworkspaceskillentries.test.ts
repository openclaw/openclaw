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

  it("loads skills from skills-index.json when indexFirst is enabled", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const extraRoot = path.join(workspaceDir, "extra-skills");

    await fs.mkdir(extraRoot, { recursive: true });
    await writeSkill({
      dir: path.join(extraRoot, "indexed-skill"),
      name: "indexed-skill",
      description: "Loaded from index",
    });
    await fs.writeFile(
      path.join(extraRoot, "skills-index.json"),
      '{"version":1,"generated":"2026-03-05T00:00:00.000Z","skills":[{"name":"indexed-skill","path":"indexed-skill"}]}',
      "utf-8",
    );

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: {
            indexFirst: true,
            extraDirs: [extraRoot],
          },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("indexed-skill");
  });

  it("falls back to scanning when the index is missing", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const extraRoot = path.join(workspaceDir, "extra-skills");

    await writeSkill({
      dir: path.join(extraRoot, "fallback-skill"),
      name: "fallback-skill",
      description: "Loaded by scan fallback",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: {
            indexFirst: true,
            extraDirs: [extraRoot],
          },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("fallback-skill");
  });

  it("does not fall back when strictIndex is enabled and the index is missing", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const extraRoot = path.join(workspaceDir, "extra-skills");

    await writeSkill({
      dir: path.join(extraRoot, "strict-skill"),
      name: "strict-skill",
      description: "Should not be loaded without an index",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: {
            indexFirst: true,
            strictIndex: true,
            extraDirs: [extraRoot],
          },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain("strict-skill");
  });

  it("loads valid index entries even when one entry is malformed", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const extraRoot = path.join(workspaceDir, "extra-skills");

    await fs.mkdir(extraRoot, { recursive: true });
    await writeSkill({
      dir: path.join(extraRoot, "valid-skill"),
      name: "valid-skill",
      description: "Still loads with a malformed sibling entry",
    });
    await fs.writeFile(
      path.join(extraRoot, "skills-index.json"),
      '{"version":1,"generated":"2026-03-05T00:00:00.000Z","skills":[{"name":"broken"},{"name":"valid-skill","path":"valid-skill"}]}',
      "utf-8",
    );

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: {
            indexFirst: true,
            extraDirs: [extraRoot],
          },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("valid-skill");
  });

  it("skips out-of-root index entries", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const extraRoot = path.join(workspaceDir, "extra-skills");

    await fs.mkdir(extraRoot, { recursive: true });
    await writeSkill({
      dir: path.join(workspaceDir, "outside-skill"),
      name: "outside-skill",
      description: "Outside the indexed root",
    });
    await fs.writeFile(
      path.join(extraRoot, "skills-index.json"),
      '{"version":1,"generated":"2026-03-05T00:00:00.000Z","skills":[{"name":"outside-skill","path":"../outside-skill"}]}',
      "utf-8",
    );

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: {
            indexFirst: true,
            extraDirs: [extraRoot],
          },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-skill");
  });

  it("skips symlinked index entries that resolve outside the root", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    const bundledDir = path.join(workspaceDir, ".bundled");
    const extraRoot = path.join(workspaceDir, "extra-skills");
    const outsideSkillDir = path.join(workspaceDir, "outside-skill");

    await fs.mkdir(extraRoot, { recursive: true });
    await writeSkill({
      dir: outsideSkillDir,
      name: "outside-skill",
      description: "Realpath escapes the indexed root",
    });
    await fs.symlink(outsideSkillDir, path.join(extraRoot, "linked-skill"));
    await fs.writeFile(
      path.join(extraRoot, "skills-index.json"),
      '{"version":1,"generated":"2026-03-05T00:00:00.000Z","skills":[{"name":"linked-skill","path":"linked-skill"}]}',
      "utf-8",
    );

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: {
            indexFirst: true,
            extraDirs: [extraRoot],
          },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-skill");
  });
});
