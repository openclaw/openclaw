import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillSnapshot, buildWorkspaceSkillsPrompt } from "./skills.js";

const tempDirs = createTrackedTempDirs();

afterEach(async () => {
  await tempDirs.cleanup();
});

describe("buildWorkspaceSkillSnapshot", () => {
  it("returns an empty snapshot when skills dirs are missing", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(snapshot.prompt).toBe("");
    expect(snapshot.skills).toEqual([]);
  });

  it("omits disable-model-invocation skills from the prompt", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "visible-skill"),
      name: "visible-skill",
      description: "Visible skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hidden-skill"),
      name: "hidden-skill",
      description: "Hidden skill",
      frontmatterExtra: "disable-model-invocation: true",
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(snapshot.prompt).toContain("visible-skill");
    expect(snapshot.prompt).not.toContain("hidden-skill");
    expect(snapshot.skills.map((skill) => skill.name).toSorted()).toEqual([
      "hidden-skill",
      "visible-skill",
    ]);
  });

  it("keeps prompt output aligned with buildWorkspaceSkillsPrompt", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "visible"),
      name: "visible",
      description: "Visible",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hidden"),
      name: "hidden",
      description: "Hidden",
      frontmatterExtra: "disable-model-invocation: true",
    });
    const config = {
      skills: {
        limits: {
          maxSkillsInPrompt: 1,
          maxSkillsPromptChars: 200,
        },
      },
    } as const;
    const opts = {
      config,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      eligibility: {
        remote: {
          platforms: ["linux"],
          hasBin: (_bin: string) => true,
          hasAnyBin: (_bins: string[]) => true,
          note: "Remote note",
        },
      },
    };

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, opts);
    const prompt = buildWorkspaceSkillsPrompt(workspaceDir, opts);

    expect(snapshot.prompt).toBe(prompt);
  });

  it("truncates the skills prompt when it exceeds the configured char budget", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");

    // Make a bunch of skills with very long descriptions.
    for (let i = 0; i < 25; i += 1) {
      const name = `skill-${String(i).padStart(2, "0")}`;
      await writeSkill({
        dir: path.join(workspaceDir, "skills", name),
        name,
        description: "x".repeat(5000),
      });
    }

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxSkillsInPrompt: 100,
            maxSkillsPromptChars: 1500,
          },
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(snapshot.prompt).toContain("⚠️ Skills truncated");
    expect(snapshot.prompt.length).toBeLessThan(5000);
  });

  it("limits discovery for nested repo-style skills roots (dir/skills/*)", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const repoDir = await tempDirs.make("openclaw-skills-repo-");

    for (let i = 0; i < 20; i += 1) {
      const name = `repo-skill-${String(i).padStart(2, "0")}`;
      await writeSkill({
        dir: path.join(repoDir, "skills", name),
        name,
        description: `Desc ${i}`,
      });
    }

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      config: {
        skills: {
          load: {
            extraDirs: [repoDir],
          },
          limits: {
            maxCandidatesPerRoot: 5,
            maxSkillsLoadedPerSource: 5,
          },
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    // We should only have loaded a small subset.
    expect(snapshot.skills.length).toBeLessThanOrEqual(5);
    expect(snapshot.prompt).toContain("repo-skill-00");
    expect(snapshot.prompt).not.toContain("repo-skill-19");
  });

  it("skips skills whose SKILL.md exceeds maxSkillFileBytes", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");

    await writeSkill({
      dir: path.join(workspaceDir, "skills", "small-skill"),
      name: "small-skill",
      description: "Small",
    });

    await writeSkill({
      dir: path.join(workspaceDir, "skills", "big-skill"),
      name: "big-skill",
      description: "Big",
      body: "x".repeat(50_000),
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxSkillFileBytes: 1000,
          },
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(snapshot.skills.map((s) => s.name)).toContain("small-skill");
    expect(snapshot.skills.map((s) => s.name)).not.toContain("big-skill");
    expect(snapshot.prompt).toContain("small-skill");
    expect(snapshot.prompt).not.toContain("big-skill");
  });

  it("detects nested skills roots beyond the first 25 entries", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const repoDir = await tempDirs.make("openclaw-skills-repo-");

    // Create 30 nested dirs, but only the last one is an actual skill.
    for (let i = 0; i < 30; i += 1) {
      await fs.mkdir(path.join(repoDir, "skills", `entry-${String(i).padStart(2, "0")}`), {
        recursive: true,
      });
    }

    await writeSkill({
      dir: path.join(repoDir, "skills", "entry-29"),
      name: "late-skill",
      description: "Nested skill discovered late",
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      config: {
        skills: {
          load: {
            extraDirs: [repoDir],
          },
          limits: {
            maxCandidatesPerRoot: 30,
            maxSkillsLoadedPerSource: 30,
          },
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(snapshot.skills.map((s) => s.name)).toContain("late-skill");
    expect(snapshot.prompt).toContain("late-skill");
  });

  it("enforces maxSkillFileBytes for root-level SKILL.md", async () => {
    const workspaceDir = await tempDirs.make("openclaw-");
    const rootSkillDir = await tempDirs.make("openclaw-root-skill-");

    await writeSkill({
      dir: rootSkillDir,
      name: "root-big-skill",
      description: "Big",
      body: "x".repeat(50_000),
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      config: {
        skills: {
          load: {
            extraDirs: [rootSkillDir],
          },
          limits: {
            maxSkillFileBytes: 1000,
          },
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(snapshot.skills.map((s) => s.name)).not.toContain("root-big-skill");
    expect(snapshot.prompt).not.toContain("root-big-skill");
  });
});
