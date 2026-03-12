import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeSkill } from "../skills.e2e-test-helpers.js";
import { loadWorkspaceSkillEntries } from "./workspace.js";

const tempDirs: string[] = [];

async function createTempWorkspaceDir() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-refs-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0, tempDirs.length).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

async function writeSkillWithReferences(params: {
  skillDir: string;
  name: string;
  description: string;
  metadata?: string;
  references?: Record<string, string>;
}) {
  await writeSkill({
    dir: params.skillDir,
    name: params.name,
    description: params.description,
    metadata: params.metadata,
  });
  if (params.references) {
    const refsDir = path.join(params.skillDir, "references");
    await fs.mkdir(refsDir, { recursive: true });
    for (const [filename, content] of Object.entries(params.references)) {
      await fs.writeFile(path.join(refsDir, filename), content, "utf-8");
    }
  }
}

describe("workspace skill references loading", () => {
  it("loads all .md files from references/ when no autoLoad is specified", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "my-skill");

    await writeSkillWithReferences({
      skillDir,
      name: "my-skill",
      description: "A test skill",
      references: {
        "guide.md": "# Guide\nSome guide content.",
        "api-spec.md": "# API Spec\nAPI specification.",
        "not-markdown.txt": "This should be ignored.",
      },
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    const entry = entries.find((e) => e.skill.name === "my-skill");
    expect(entry).toBeDefined();
    expect(entry!.referencesContent).toBeDefined();
    // Should include both .md files but not .txt
    expect(entry!.referencesContent).toContain("<!-- references/api-spec.md -->");
    expect(entry!.referencesContent).toContain("# API Spec");
    expect(entry!.referencesContent).toContain("<!-- references/guide.md -->");
    expect(entry!.referencesContent).toContain("# Guide");
    expect(entry!.referencesContent).not.toContain("not-markdown.txt");
    // Alphabetical order: api-spec.md before guide.md
    const apiIdx = entry!.referencesContent!.indexOf("api-spec.md");
    const guideIdx = entry!.referencesContent!.indexOf("guide.md");
    expect(apiIdx).toBeLessThan(guideIdx);
  });

  it("loads only autoLoad files when specified in frontmatter", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "selective-skill");

    await writeSkillWithReferences({
      skillDir,
      name: "selective-skill",
      description: "A skill with selective references",
      metadata: '{"openclaw":{"references":{"autoLoad":["important.md"]}}}',
      references: {
        "important.md": "# Important\nCritical reference.",
        "optional.md": "# Optional\nNot loaded by default.",
      },
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    const entry = entries.find((e) => e.skill.name === "selective-skill");
    expect(entry).toBeDefined();
    expect(entry!.referencesContent).toContain("<!-- references/important.md -->");
    expect(entry!.referencesContent).toContain("# Important");
    // optional.md should NOT be loaded since autoLoad explicitly lists only important.md
    expect(entry!.referencesContent).not.toContain("optional.md");
  });

  it("returns no referencesContent when references/ does not exist", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "no-refs-skill");

    await writeSkill({
      dir: skillDir,
      name: "no-refs-skill",
      description: "A skill without references",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    const entry = entries.find((e) => e.skill.name === "no-refs-skill");
    expect(entry).toBeDefined();
    expect(entry!.referencesContent).toBeUndefined();
  });

  it("returns no referencesContent when references/ is empty", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "empty-refs");

    await writeSkill({
      dir: skillDir,
      name: "empty-refs",
      description: "A skill with empty references",
    });
    await fs.mkdir(path.join(skillDir, "references"), { recursive: true });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    const entry = entries.find((e) => e.skill.name === "empty-refs");
    expect(entry).toBeDefined();
    expect(entry!.referencesContent).toBeUndefined();
  });

  it("skips filenames with path traversal patterns", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "traversal-skill");

    await writeSkillWithReferences({
      skillDir,
      name: "traversal-skill",
      description: "A skill to test path traversal defense",
      metadata:
        '{"openclaw":{"references":{"autoLoad":["../../../etc/passwd.md","safe.md","..\\\\secret.md"]}}}',
      references: {
        "safe.md": "# Safe\nThis is safe.",
      },
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    const entry = entries.find((e) => e.skill.name === "traversal-skill");
    expect(entry).toBeDefined();
    // Only the safe file should be loaded
    expect(entry!.referencesContent).toContain("<!-- references/safe.md -->");
    expect(entry!.referencesContent).not.toContain("passwd");
    expect(entry!.referencesContent).not.toContain("secret");
  });

  it("skips non-.md filenames in autoLoad", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "ext-skill");

    await writeSkillWithReferences({
      skillDir,
      name: "ext-skill",
      description: "A skill with non-md autoLoad entries",
      metadata: '{"openclaw":{"references":{"autoLoad":["good.md","evil.sh"]}}}',
      references: {
        "good.md": "# Good\nGood content.",
        "evil.sh": "#!/bin/bash\nrm -rf /",
      },
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    const entry = entries.find((e) => e.skill.name === "ext-skill");
    expect(entry).toBeDefined();
    expect(entry!.referencesContent).toContain("<!-- references/good.md -->");
    expect(entry!.referencesContent).not.toContain("evil.sh");
    expect(entry!.referencesContent).not.toContain("rm -rf");
  });

  it("parses references metadata from frontmatter correctly", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "meta-skill");

    await writeSkillWithReferences({
      skillDir,
      name: "meta-skill",
      description: "A skill with full references metadata",
      metadata: '{"openclaw":{"references":{"autoLoad":["a.md","b.md"],"onDemand":["c.md"]}}}',
      references: {
        "a.md": "Content A",
        "b.md": "Content B",
        "c.md": "Content C",
      },
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    const entry = entries.find((e) => e.skill.name === "meta-skill");
    expect(entry).toBeDefined();
    expect(entry!.metadata?.references).toEqual({
      autoLoad: ["a.md", "b.md"],
      onDemand: ["c.md"],
    });
    // Only autoLoad files should be in referencesContent (not onDemand)
    expect(entry!.referencesContent).toContain("Content A");
    expect(entry!.referencesContent).toContain("Content B");
    expect(entry!.referencesContent).not.toContain("Content C");
  });
});
