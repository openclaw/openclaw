import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SkillEntry, SkillSnapshot } from "./skills/types.js";
import { resolveSkillsPromptForRun } from "./skills.js";

describe("resolveSkillsPromptForRun", () => {
  it("re-generates prompt from resolvedSkills when available (portability fix)", () => {
    const home = os.homedir();
    // Simulate a snapshot created on a *different* machine with a foreign home dir baked in.
    const foreignHome = "/Users/alice";
    const foreignPath = `${foreignHome}/.openclaw/skills/demo-skill/SKILL.md`;
    const snapshot: SkillSnapshot = {
      // The cached prompt contains the foreign machine's absolute path.
      prompt: `<available_skills>\n<skill name="demo-skill" file_path="${foreignPath}">\nDemo\n</skill>\n</available_skills>`,
      skills: [{ name: "demo-skill" }],
      resolvedSkills: [
        {
          name: "demo-skill",
          description: "Demo",
          // The resolvedSkills store the *actual* absolute path on the current machine.
          filePath: path.join(home, ".openclaw/skills/demo-skill/SKILL.md"),
          baseDir: path.join(home, ".openclaw/skills/demo-skill"),
          source: "openclaw-managed",
          disableModelInvocation: false,
        },
      ],
    };
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: snapshot,
      workspaceDir: "/tmp/openclaw",
    });
    // The prompt should use `~/` (compacted from current home), NOT the foreign path.
    expect(prompt).toContain("~/.openclaw/skills/demo-skill/SKILL.md");
    expect(prompt).not.toContain(foreignHome);
  });

  it("falls back to cached prompt for legacy snapshots without resolvedSkills", () => {
    const prompt = resolveSkillsPromptForRun({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("SNAPSHOT");
  });

  it("builds prompt from entries when snapshot is missing", () => {
    const entry: SkillEntry = {
      skill: {
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
        disableModelInvocation: false,
      },
      frontmatter: {},
    };
    const prompt = resolveSkillsPromptForRun({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });
});
