import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { withEnv } from "../test-utils/env.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillsPrompt, syncSkillsToWorkspace } from "./skills/workspace.js";

vi.mock("./skills/plugin-skills.js", () => ({
  resolvePluginSkillDirs: () => [],
}));

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

let fixtureRoot = "";
let fixtureCount = 0;
let syncSourceTemplateDir = "";

async function createCaseDir(prefix: string): Promise<string> {
  const dir = path.join(fixtureRoot, `${prefix}-${fixtureCount++}`);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

async function syncSourceSkillsToTarget(sourceWorkspace: string, targetWorkspace: string) {
  await syncSkillsToWorkspace({
    sourceWorkspaceDir: sourceWorkspace,
    targetWorkspaceDir: targetWorkspace,
    bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
    managedSkillsDir: path.join(sourceWorkspace, ".managed"),
  });
}

async function expectSyncedSkillConfinement(params: {
  sourceWorkspace: string;
  targetWorkspace: string;
  safeSkillDirName: string;
  escapedDest: string;
}) {
  expect(await pathExists(params.escapedDest)).toBe(false);
  await syncSourceSkillsToTarget(params.sourceWorkspace, params.targetWorkspace);
  expect(
    await pathExists(
      path.join(params.targetWorkspace, "skills", params.safeSkillDirName, "SKILL.md"),
    ),
  ).toBe(true);
  expect(await pathExists(params.escapedDest)).toBe(false);
}

beforeAll(async () => {
  fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-sync-suite-"));
  syncSourceTemplateDir = await createCaseDir("source-template");
  await writeSkill({
    dir: path.join(syncSourceTemplateDir, ".extra", "demo-skill"),
    name: "demo-skill",
    description: "Extra version",
  });
  await writeSkill({
    dir: path.join(syncSourceTemplateDir, ".bundled", "demo-skill"),
    name: "demo-skill",
    description: "Bundled version",
  });
  await writeSkill({
    dir: path.join(syncSourceTemplateDir, ".managed", "demo-skill"),
    name: "demo-skill",
    description: "Managed version",
  });
  await writeSkill({
    dir: path.join(syncSourceTemplateDir, "skills", "demo-skill"),
    name: "demo-skill",
    description: "Workspace version",
  });
});

afterAll(async () => {
  await fs.rm(fixtureRoot, { recursive: true, force: true });
});

describe("buildWorkspaceSkillsPrompt", () => {
  const buildPrompt = (
    workspaceDir: string,
    opts?: Parameters<typeof buildWorkspaceSkillsPrompt>[1],
  ) =>
    withEnv({ HOME: workspaceDir }, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, {
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        ...opts,
      }),
    );

  const cloneSourceTemplate = async () => {
    const sourceWorkspace = await createCaseDir("source");
    await fs.cp(syncSourceTemplateDir, sourceWorkspace, { recursive: true });
    return sourceWorkspace;
  };

  it("syncs merged skills into a target workspace", async () => {
    const sourceWorkspace = await cloneSourceTemplate();
    const targetWorkspace = await createCaseDir("target");
    const extraDir = path.join(sourceWorkspace, ".extra");
    const bundledDir = path.join(sourceWorkspace, ".bundled");
    const managedDir = path.join(sourceWorkspace, ".managed");
    const workspaceSkillDir = path.join(sourceWorkspace, "skills", "demo-skill");

    await fs.mkdir(path.join(workspaceSkillDir, ".git"), { recursive: true });
    await fs.writeFile(path.join(workspaceSkillDir, ".git", "config"), "gitdir");
    await fs.mkdir(path.join(workspaceSkillDir, "node_modules", "pkg"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceSkillDir, "node_modules", "pkg", "index.js"),
      "export {}",
    );

    await syncSkillsToWorkspace({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      config: { skills: { load: { extraDirs: [extraDir] } } },
      bundledSkillsDir: bundledDir,
      managedSkillsDir: managedDir,
    });

    const prompt = buildPrompt(targetWorkspace, {
      bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
      managedSkillsDir: path.join(targetWorkspace, ".managed"),
    });

    expect(prompt).toContain("Workspace version");
    expect(prompt).not.toContain("Managed version");
    expect(prompt).not.toContain("Bundled version");
    expect(prompt).not.toContain("Extra version");
    expect(prompt.replaceAll("\\", "/")).toContain("demo-skill/SKILL.md");
    expect(await pathExists(path.join(targetWorkspace, "skills", "demo-skill", ".git"))).toBe(
      false,
    );
    expect(
      await pathExists(path.join(targetWorkspace, "skills", "demo-skill", "node_modules")),
    ).toBe(false);
  });

  it("syncs the explicit agent skill subset instead of inherited defaults", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "foo_bar"),
      name: "foo_bar",
      description: "Underscore variant",
    });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "foo.dot"),
      name: "foo.dot",
      description: "Dot variant",
    });

    await syncSkillsToWorkspace({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      agentId: "alpha",
      config: {
        agents: {
          defaults: {
            skills: ["foo_bar", "foo.dot"],
          },
          list: [{ id: "alpha", skills: ["foo_bar"] }],
        },
      },
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    const prompt = buildPrompt(targetWorkspace, {
      bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
      managedSkillsDir: path.join(targetWorkspace, ".managed"),
    });

    expect(prompt).toContain("Underscore variant");
    expect(prompt).not.toContain("Dot variant");
    expect(await pathExists(path.join(targetWorkspace, "skills", "foo_bar", "SKILL.md"))).toBe(
      true,
    );
    expect(await pathExists(path.join(targetWorkspace, "skills", "foo.dot", "SKILL.md"))).toBe(
      false,
    );
  });
  it.runIf(process.platform !== "win32")(
    "does not sync workspace skills that resolve outside the source workspace root",
    async () => {
      const sourceWorkspace = await createCaseDir("source");
      const targetWorkspace = await createCaseDir("target");
      const outsideRoot = await createCaseDir("outside");
      const outsideSkillDir = path.join(outsideRoot, "escaped-skill");

      await writeSkill({
        dir: outsideSkillDir,
        name: "escaped-skill",
        description: "Outside source workspace",
      });
      await fs.mkdir(path.join(sourceWorkspace, "skills"), { recursive: true });
      await fs.symlink(
        outsideSkillDir,
        path.join(sourceWorkspace, "skills", "escaped-skill"),
        "dir",
      );

      await syncSourceSkillsToTarget(sourceWorkspace, targetWorkspace);

      const prompt = buildPrompt(targetWorkspace, {
        bundledSkillsDir: path.join(targetWorkspace, ".bundled"),
        managedSkillsDir: path.join(targetWorkspace, ".managed"),
      });

      expect(prompt).not.toContain("escaped-skill");
      expect(
        await pathExists(path.join(targetWorkspace, "skills", "escaped-skill", "SKILL.md")),
      ).toBe(false);
    },
  );
  it("keeps synced skills confined under target workspace when frontmatter name uses traversal", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const escapeId = fixtureCount;
    const traversalName = `../../../skill-sync-escape-${escapeId}`;
    const escapedDest = path.resolve(targetWorkspace, "skills", traversalName);

    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "safe-traversal-skill"),
      name: traversalName,
      description: "Traversal skill",
    });

    expect(path.relative(path.join(targetWorkspace, "skills"), escapedDest).startsWith("..")).toBe(
      true,
    );
    await expectSyncedSkillConfinement({
      sourceWorkspace,
      targetWorkspace,
      safeSkillDirName: "safe-traversal-skill",
      escapedDest,
    });
  });
  it("keeps synced skills confined under target workspace when frontmatter name is absolute", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    const escapeId = fixtureCount;
    const absoluteDest = path.join(os.tmpdir(), `skill-sync-abs-escape-${escapeId}`);

    await fs.rm(absoluteDest, { recursive: true, force: true });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "safe-absolute-skill"),
      name: absoluteDest,
      description: "Absolute skill",
    });

    await expectSyncedSkillConfinement({
      sourceWorkspace,
      targetWorkspace,
      safeSkillDirName: "safe-absolute-skill",
      escapedDest: absoluteDest,
    });
  });
  it("filters skills based on env/config gates", async () => {
    const workspaceDir = await createCaseDir("workspace");
    const skillDir = path.join(workspaceDir, "skills", "image-lab");
    await writeSkill({
      dir: skillDir,
      name: "image-lab",
      description: "Generates images",
      metadata:
        '{"openclaw":{"requires":{"env":["GEMINI_API_KEY"]},"primaryEnv":"GEMINI_API_KEY"}}',
      body: "# Image Lab\n",
    });

    withEnv({ GEMINI_API_KEY: undefined }, () => {
      const missingPrompt = buildPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: { skills: { entries: { "image-lab": { apiKey: "" } } } },
      });
      expect(missingPrompt).not.toContain("image-lab");

      const enabledPrompt = buildPrompt(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        config: {
          skills: { entries: { "image-lab": { apiKey: "test-key" } } }, // pragma: allowlist secret
        },
      });
      expect(enabledPrompt).toContain("image-lab");
    });
  });
  it("applies skill filters, including empty lists", async () => {
    const workspaceDir = await createCaseDir("workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "alpha"),
      name: "alpha",
      description: "Alpha skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "beta"),
      name: "beta",
      description: "Beta skill",
    });

    const filteredPrompt = buildPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter: ["alpha"],
    });
    expect(filteredPrompt).toContain("alpha");
    expect(filteredPrompt).not.toContain("beta");

    const emptyPrompt = buildPrompt(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      skillFilter: [],
    });
    expect(emptyPrompt).toBe("");
  });

  it("syncs remote-eligible filtered skills into the target workspace", async () => {
    const sourceWorkspace = await createCaseDir("source");
    const targetWorkspace = await createCaseDir("target");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "remote-only"),
      name: "remote-only",
      description: "Sandbox-only bin",
      metadata: '{"openclaw":{"requires":{"anyBins":["missingbin","sandboxbin"]}}}',
    });

    await syncSkillsToWorkspace({
      sourceWorkspaceDir: sourceWorkspace,
      targetWorkspaceDir: targetWorkspace,
      agentId: "alpha",
      config: {
        agents: {
          defaults: {
            skills: ["remote-only"],
          },
          list: [{ id: "alpha" }],
        },
      },
      eligibility: {
        remote: {
          platforms: ["linux"],
          hasBin: () => false,
          hasAnyBin: (bins: string[]) => bins.includes("sandboxbin"),
          note: "sandbox",
        },
      },
      bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
      managedSkillsDir: path.join(sourceWorkspace, ".managed"),
    });

    expect(await pathExists(path.join(targetWorkspace, "skills", "remote-only", "SKILL.md"))).toBe(
      true,
    );
  });
});

describe("syncSkillsToWorkspace non-destructive sync", () => {
  const syncSkills = async (sourceWorkspace: string, targetWorkspace: string) =>
    withEnv({ HOME: sourceWorkspace }, () =>
      syncSkillsToWorkspace({
        sourceWorkspaceDir: sourceWorkspace,
        targetWorkspaceDir: targetWorkspace,
        bundledSkillsDir: path.join(sourceWorkspace, ".bundled"),
        managedSkillsDir: path.join(sourceWorkspace, ".managed"),
      }),
    );

  it("does not wipe previously synced skills when the source load returns empty", async () => {
    const sourceWorkspace = await createCaseDir("src-full");
    const targetWorkspace = await createCaseDir("target-existing");

    // First sync: source has two skills. Target should receive both.
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "alpha"),
      name: "alpha",
      description: "Alpha skill",
    });
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "beta"),
      name: "beta",
      description: "Beta skill",
    });
    await syncSkills(sourceWorkspace, targetWorkspace);
    expect(await pathExists(path.join(targetWorkspace, "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(targetWorkspace, "skills", "beta", "SKILL.md"))).toBe(true);

    // Second sync with a completely empty source skills dir (simulating a
    // transient load failure where loadWorkspaceSkillEntries returns []).
    // Previously the implementation would wipe the entire target skills
    // directory — now it must keep both existing skill directories intact.
    const emptySource = await createCaseDir("src-empty");
    await syncSkills(emptySource, targetWorkspace);
    expect(await pathExists(path.join(targetWorkspace, "skills", "alpha", "SKILL.md"))).toBe(true);
    expect(await pathExists(path.join(targetWorkspace, "skills", "beta", "SKILL.md"))).toBe(true);
  });

  it("preserves unrelated user-created directories in the target skills dir", async () => {
    const sourceWorkspace = await createCaseDir("src-one");
    const targetWorkspace = await createCaseDir("target-mixed");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "alpha"),
      name: "alpha",
      description: "Alpha skill",
    });

    // Simulate a skill that was installed directly inside the sandbox by
    // the user/agent and is not part of the source manifest.
    await writeSkill({
      dir: path.join(targetWorkspace, "skills", "user-made"),
      name: "user-made",
      description: "User-installed skill",
    });

    await syncSkills(sourceWorkspace, targetWorkspace);

    expect(await pathExists(path.join(targetWorkspace, "skills", "alpha", "SKILL.md"))).toBe(true);
    // The user-installed skill must not be touched.
    expect(await pathExists(path.join(targetWorkspace, "skills", "user-made", "SKILL.md"))).toBe(
      true,
    );
  });

  it("skips re-copying when the destination is already up to date", async () => {
    const sourceWorkspace = await createCaseDir("src-mtime");
    const targetWorkspace = await createCaseDir("target-mtime");
    await writeSkill({
      dir: path.join(sourceWorkspace, "skills", "alpha"),
      name: "alpha",
      description: "Alpha skill",
    });
    await syncSkills(sourceWorkspace, targetWorkspace);

    const destSkillMd = path.join(targetWorkspace, "skills", "alpha", "SKILL.md");
    const firstMtime = (await fs.stat(destSkillMd)).mtimeMs;

    // Second sync with no source changes: destination mtime should stay
    // unchanged because the incremental skip path avoids re-copying.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await syncSkills(sourceWorkspace, targetWorkspace);
    const secondMtime = (await fs.stat(destSkillMd)).mtimeMs;
    expect(secondMtime).toBe(firstMtime);
  });

  it("re-copies a skill when the source has been modified after the previous sync", async () => {
    const sourceWorkspace = await createCaseDir("src-change");
    const targetWorkspace = await createCaseDir("target-change");
    const sourceSkillDir = path.join(sourceWorkspace, "skills", "alpha");
    await writeSkill({
      dir: sourceSkillDir,
      name: "alpha",
      description: "Original",
    });
    await syncSkills(sourceWorkspace, targetWorkspace);

    const destSkillMd = path.join(targetWorkspace, "skills", "alpha", "SKILL.md");
    expect((await fs.readFile(destSkillMd, "utf-8")).includes("Original")).toBe(true);

    // Wait past filesystem mtime resolution, then modify source.
    await new Promise((resolve) => setTimeout(resolve, 50));
    await writeSkill({
      dir: sourceSkillDir,
      name: "alpha",
      description: "Updated",
    });

    await syncSkills(sourceWorkspace, targetWorkspace);
    expect((await fs.readFile(destSkillMd, "utf-8")).includes("Updated")).toBe(true);
  });
});
