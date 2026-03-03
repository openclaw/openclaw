import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { shouldIncludeSkill } from "./config.js";
import type { SkillEntry } from "./types.js";

function makeEntry(overrides?: Partial<SkillEntry>): SkillEntry {
  return {
    skill: {
      name: "test-skill",
      description: "A test skill",
      filePath: "/skills/test-skill/SKILL.md",
      baseDir: "/skills/test-skill",
      source: "openclaw-bundled",
      disableModelInvocation: false,
    },
    frontmatter: {},
    metadata: {
      requires: { bins: ["nonexistent-bin"] },
    },
    ...overrides,
  };
}

describe("shouldIncludeSkill", () => {
  it("force-disables when enabled is false", () => {
    const result = shouldIncludeSkill({
      entry: makeEntry(),
      config: { skills: { entries: { "test-skill": { enabled: false } } } },
    });
    expect(result).toBe(false);
  });

  it("force-enables when enabled is true, bypassing requires.bins", () => {
    const result = shouldIncludeSkill({
      entry: makeEntry(),
      config: { skills: { entries: { "test-skill": { enabled: true } } } },
    });
    expect(result).toBe(true);
  });

  it("falls through to runtime eligibility when enabled is undefined", () => {
    // requires.bins = ["nonexistent-bin"] and hasBinary will return false
    const result = shouldIncludeSkill({
      entry: makeEntry(),
    });
    expect(result).toBe(false);
  });

  it("respects allowBundled even when enabled is true", () => {
    const config: OpenClawConfig = {
      skills: {
        allowBundled: ["other-skill"],
        entries: { "test-skill": { enabled: true } },
      },
    };
    const result = shouldIncludeSkill({
      entry: makeEntry(),
      config,
    });
    expect(result).toBe(false);
  });
});
