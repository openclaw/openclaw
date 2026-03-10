import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSkill } from "../skills.e2e-test-helpers.js";
import { syncSkillsToWorkspace } from "./workspace.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("syncSkillsToWorkspace", () => {
  it("only copies bundled skills allowed by skills.allowBundled", async () => {
    const sourceWorkspaceDir = await makeTempDir("openclaw-skills-source-");
    const targetWorkspaceDir = await makeTempDir("openclaw-skills-target-");
    const bundledSkillsDir = await makeTempDir("openclaw-skills-bundled-");

    await writeSkill({
      dir: path.join(bundledSkillsDir, "frontend-design"),
      name: "frontend-design",
      description: "allowed bundled skill",
    });
    await writeSkill({
      dir: path.join(bundledSkillsDir, "ops-debug"),
      name: "ops-debug",
      description: "filtered bundled skill",
    });

    await syncSkillsToWorkspace({
      sourceWorkspaceDir,
      targetWorkspaceDir,
      bundledSkillsDir,
      config: {
        skills: {
          allowBundled: ["frontend-design"],
        },
      },
    });

    const syncedEntries = await fs.readdir(path.join(targetWorkspaceDir, "skills"));
    expect(syncedEntries).toEqual(["frontend-design"]);
  });
});
