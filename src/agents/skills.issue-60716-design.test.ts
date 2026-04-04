import { describe, expect, it } from "vitest";
import { createCanonicalFixtureSkill } from "./skills.test-helpers.js";
import { shouldIncludeSkill } from "./skills/config.js";
import { resolveSkillInvocationPolicy } from "./skills/frontmatter.js";
import { formatSkillsForPrompt } from "./skills/skill-contract.js";

describe("issue 60716 design target", () => {
  it("documents the resolved alignment between runtime inclusion and prompt visibility", () => {
    const frontmatter = { "disable-model-invocation": "true" } as const;
    const invocation = resolveSkillInvocationPolicy(frontmatter as never);
    const skill = createCanonicalFixtureSkill({
      name: "system-fix-skill",
      description: "desc",
      filePath: "/tmp/system-fix/SKILL.md",
      baseDir: "/tmp/system-fix",
      source: "workspace",
      disableModelInvocation: invocation.disableModelInvocation,
    });
    const entry = {
      skill,
      frontmatter,
      metadata: undefined,
      invocation,
      exposure: {
        includeInRuntimeRegistry: true,
        includeInAvailableSkillsPrompt: true,
        userInvocable: true,
      },
    };

    const included = shouldIncludeSkill({ entry, config: undefined, eligibility: undefined });
    const prompt = formatSkillsForPrompt([skill]);

    expect(included).toBe(true);
    expect(prompt).toContain("<name>system-fix-skill</name>");
  });
});
