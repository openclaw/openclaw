import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withEnv } from "../../test-utils/env.js";
import { createFixtureSuite } from "../../test-utils/fixture-suite.js";
import { writeSkill } from "../skills.e2e-test-helpers.js";
import { canReuseSkillSnapshot } from "./snapshot-cache.js";
import { buildWorkspaceSkillSnapshot } from "./workspace.js";

const fixtureSuite = createFixtureSuite("openclaw-skills-workspace-suite-");

function withWorkspaceHome<T>(workspaceDir: string, cb: () => T): T {
  return withEnv({ HOME: workspaceDir, PATH: "" }, cb);
}

function extractPromptSkillNames(prompt: string): string[] {
  return Array.from(prompt.matchAll(/<name>([^<]+)<\/name>/g), (match) => match[1] ?? "");
}

describe("skills workspace snapshot behavior", () => {
  beforeAll(async () => {
    await fixtureSuite.setup();
  });

  afterAll(async () => {
    await fixtureSuite.cleanup();
  });

  it("prioritizes skills by skillKey aliases", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "alpha-skill"),
      name: "alpha-skill",
      description: "Alpha",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "zeta-skill"),
      name: "zeta-skill",
      description: "Zeta",
      metadata: '{"openclaw":{"skillKey":"wechat-reader"}}',
    });

    const snapshot = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillSnapshot(workspaceDir, {
        config: {
          skills: {
            priority: ["wechat-reader"],
            limits: {
              maxSkillsInPrompt: 10,
              maxSkillsPromptChars: 5_000,
            },
          },
        },
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      }),
    );

    expect(extractPromptSkillNames(snapshot.prompt)).toEqual(["zeta-skill", "alpha-skill"]);
  });

  it("keeps priority matching the original skill name when aliases are present", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "alpha-skill"),
      name: "alpha-skill",
      description: "Alpha",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "zeta-skill"),
      name: "zeta-skill",
      description: "Zeta",
      metadata: '{"openclaw":{"skillKey":"wechat-reader"}}',
    });

    const snapshot = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillSnapshot(workspaceDir, {
        config: {
          skills: {
            priority: ["zeta-skill"],
            limits: {
              maxSkillsInPrompt: 10,
              maxSkillsPromptChars: 5_000,
            },
          },
        },
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      }),
    );

    expect(extractPromptSkillNames(snapshot.prompt)).toEqual(["zeta-skill", "alpha-skill"]);
  });

  it("invalidates cached snapshots when skills.priority changes", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "alpha-skill"),
      name: "alpha-skill",
      description: "Alpha",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "beta-skill"),
      name: "beta-skill",
      description: "Beta",
    });

    const config = {
      skills: {
        priority: ["alpha-skill"],
      },
    };
    const snapshot = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillSnapshot(workspaceDir, {
        config,
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
        snapshotVersion: 7,
      }),
    );

    expect(
      canReuseSkillSnapshot({
        snapshot,
        snapshotVersion: 7,
        config,
      }),
    ).toBe(true);
    expect(
      canReuseSkillSnapshot({
        snapshot,
        snapshotVersion: 7,
        config: {
          skills: {
            priority: ["beta-skill"],
          },
        },
      }),
    ).toBe(false);
  });
});
