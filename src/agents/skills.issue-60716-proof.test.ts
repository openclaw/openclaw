import { describe, expect, it } from "vitest";
import { shouldIncludeSkill } from "./skills/config.js";
import { resolveSkillInvocationPolicy } from "./skills/frontmatter.js";
import { formatSkillsForPrompt } from "./skills/skill-contract.js";

describe("issue 60716 proof", () => {
  it("keeps formatter output and runtime inclusion aligned for disable-model-invocation skills", () => {
    const frontmatter = {
      "disable-model-invocation": "true",
    } as const;

    const invocation = resolveSkillInvocationPolicy(frontmatter as never);
    const skill = {
      name: "proof-skill",
      description: "proof desc",
      filePath: "/tmp/proof/SKILL.md",
      content: "# proof",
      baseDir: "/tmp/proof",
      disableModelInvocation: invocation.disableModelInvocation,
    };

    const entry = {
      skill,
      frontmatter,
      metadata: undefined,
      invocation,
    };

    const included = shouldIncludeSkill({ entry, config: undefined, eligibility: undefined });
    const prompt = formatSkillsForPrompt([skill]);

    expect(included).toBe(true);
    expect(skill.disableModelInvocation).toBe(true);
    expect(prompt).toContain("<name>proof-skill</name>");
  });
});
