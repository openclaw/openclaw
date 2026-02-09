import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillSnapshot } from "./skills.js";

async function _writeSkill(params: {
  dir: string;
  name: string;
  description: string;
  metadata?: string;
  frontmatterExtra?: string;
  body?: string;
}) {
  const { dir, name, description, metadata, frontmatterExtra, body } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}${metadata ? `\nmetadata: ${metadata}` : ""}
${frontmatterExtra ?? ""}
---

${body ?? `# ${name}\n`}
`,
    "utf-8",
  );
}

describe("buildWorkspaceSkillSnapshot", () => {
  it("returns an empty snapshot when skills dirs are missing", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(snapshot.prompt).toBe("");
    expect(snapshot.skills).toEqual([]);
  });

  it("omits disable-model-invocation skills from the prompt", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
    await _writeSkill({
      dir: path.join(workspaceDir, "skills", "visible-skill"),
      name: "visible-skill",
      description: "Visible skill",
    });
    await _writeSkill({
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

  it("applies skillFilter to restrict skills to the allowlist", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
    await _writeSkill({
      dir: path.join(workspaceDir, "skills", "alpha"),
      name: "alpha",
      description: "Alpha skill",
    });
    await _writeSkill({
      dir: path.join(workspaceDir, "skills", "bravo"),
      name: "bravo",
      description: "Bravo skill",
    });
    await _writeSkill({
      dir: path.join(workspaceDir, "skills", "charlie"),
      name: "charlie",
      description: "Charlie skill",
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      skillFilter: ["alpha", "charlie"],
    });

    // Only the skills in the filter should appear in the prompt
    expect(snapshot.prompt).toContain("alpha");
    expect(snapshot.prompt).not.toContain("bravo");
    expect(snapshot.prompt).toContain("charlie");
    // The skills list should also be filtered
    expect(snapshot.skills.map((skill) => skill.name).toSorted()).toEqual(["alpha", "charlie"]);
  });

  it("returns empty snapshot when skillFilter is an empty array", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
    await _writeSkill({
      dir: path.join(workspaceDir, "skills", "alpha"),
      name: "alpha",
      description: "Alpha skill",
    });

    const snapshot = buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      skillFilter: [],
    });

    expect(snapshot.prompt).toBe("");
    expect(snapshot.skills).toEqual([]);
  });
});
