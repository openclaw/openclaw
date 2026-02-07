import { describe, it, expect } from "vitest";
import type { SkillEntry } from "./types.js";
import { filterPromptEligibleSkills } from "./workspace.js";

// Mock minimal skill entry structure for testing
const mockEntry = (name: string, always?: boolean | string, disabled?: boolean): SkillEntry => ({
  skill: { name } as any,
  frontmatter: { always: always as any },
  invocation: disabled ? { disableModelInvocation: true } : undefined,
});

describe("filterPromptEligibleSkills", () => {
  it("includes skills explicitly marked as always: true", () => {
    const skills = [mockEntry("skill-a", true), mockEntry("skill-b", false)];
    const result = filterPromptEligibleSkills(skills);
    expect(result).toHaveLength(1);
    expect(result[0].skill.name).toBe("skill-a");
  });

  it("includes skills marked as always: 'true' (string)", () => {
    const skills = [mockEntry("skill-a", "true"), mockEntry("skill-b", "false")];
    const result = filterPromptEligibleSkills(skills);
    expect(result).toHaveLength(1);
    expect(result[0].skill.name).toBe("skill-a");
  });

  it("always includes skills-search", () => {
    const skills = [mockEntry("skills-search"), mockEntry("other-skill")];
    const result = filterPromptEligibleSkills(skills);
    expect(result).toHaveLength(1);
    expect(result[0].skill.name).toBe("skills-search");
  });

  it("excludes disabled skills even if always is true", () => {
    const skills = [
      mockEntry("skill-a", true, true), // disabled
    ];
    const result = filterPromptEligibleSkills(skills);
    expect(result).toHaveLength(0);
  });
});
