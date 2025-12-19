import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildWorkspaceSkillsPrompt } from "./skills.js";

describe("buildWorkspaceSkillsPrompt", () => {
  it("loads skills from workspace skills/", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdis-"));
    const skillDir = path.join(workspaceDir, "skills", "demo-skill");
    await fs.mkdir(skillDir, { recursive: true });

    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      `---
name: demo-skill
description: Does demo things
---

# Demo Skill
`,
      "utf-8",
    );

    const prompt = buildWorkspaceSkillsPrompt(workspaceDir);
    expect(prompt).toContain("demo-skill");
    expect(prompt).toContain("Does demo things");
    expect(prompt).toContain(path.join(skillDir, "SKILL.md"));
  });
});
