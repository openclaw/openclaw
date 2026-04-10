import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../../test-utils/tracked-temp-dirs.js";
import { loadWorkspaceSkillEntries } from "./workspace.js";

const tempDirs = createTrackedTempDirs();

async function writeSkill(rootDir: string, name: string) {
  const skillDir = path.join(rootDir, name);
  await fs.mkdir(skillDir, { recursive: true });
  await fs.writeFile(
    path.join(skillDir, "SKILL.md"),
    `---\nname: ${name}\ndescription: test skill\n---\n\n# ${name}\n`,
    "utf8",
  );
}

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("loadWorkspaceSkillEntries", () => {
  it("sorts merged skills alphabetically regardless of extraDirs order", async () => {
    const workspaceDir = await tempDirs.make("openclaw-workspace-");
    const extraDirA = await tempDirs.make("openclaw-skills-z-");
    const extraDirB = await tempDirs.make("openclaw-skills-a-");
    const managedDir = await tempDirs.make("openclaw-managed-");
    const bundledDir = await tempDirs.make("openclaw-bundled-");

    await writeSkill(extraDirA, "zulu");
    await writeSkill(extraDirB, "alpha");

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        skills: {
          load: {
            extraDirs: [extraDirA, extraDirB],
          },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toEqual(["alpha", "zulu"]);
  });
});
