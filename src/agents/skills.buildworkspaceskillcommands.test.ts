import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkspaceSkillCommandSpecs } from "./skills.js";

async function writeSkill(params: {
  dir: string;
  name: string;
  description: string;
  frontmatterExtra?: string;
}) {
  const { dir, name, description, frontmatterExtra } = params;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "SKILL.md"),
    `---
name: ${name}
description: ${description}
${frontmatterExtra ?? ""}
---

# ${name}
`,
    "utf-8",
  );
}

describe("buildWorkspaceSkillCommandSpecs", () => {
  it("sanitizes and de-duplicates command names", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-"));
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hello-world"),
      name: "hello-world",
      description: "Hello world skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hello_world"),
      name: "hello_world",
      description: "Hello underscore skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "help"),
      name: "help",
      description: "Help skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hidden"),
      name: "hidden-skill",
      description: "Hidden skill",
      frontmatterExtra: "user-invocable: false",
    });

    const commands = buildWorkspaceSkillCommandSpecs(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      reservedNames: new Set(["help"]),
    });

    const names = commands.map((entry) => entry.name).sort();
    expect(names).toEqual(["hello_world", "hello_world_2", "help_2"]);
    expect(commands.find((entry) => entry.skillName === "hidden-skill")).toBeUndefined();
  });
});
