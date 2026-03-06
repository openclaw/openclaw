import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseFrontmatter, resolveSkillInvocationPolicy } from "./skills/frontmatter.js";

describe("skills/youtube-summary frontmatter", () => {
  it("keeps the skill off the public slash-command surface", () => {
    const skillPath = path.join(process.cwd(), "skills", "youtube-summary", "SKILL.md");
    const raw = fs.readFileSync(skillPath, "utf-8");
    const frontmatter = parseFrontmatter(raw);
    const policy = resolveSkillInvocationPolicy(frontmatter);

    expect(policy.userInvocable).toBe(false);
  });
});
