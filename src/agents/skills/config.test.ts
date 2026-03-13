import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SkillEntry } from "./types.js";
import { shouldIncludeSkill } from "./config.js";

/**
 * Build a minimal SkillEntry for testing shouldIncludeSkill.
 */
function makeEntry(overrides?: {
  name?: string;
  source?: string;
  requiresBins?: string[];
}): SkillEntry {
  const name = overrides?.name ?? "test-skill";
  return {
    skill: {
      name,
      description: "A test skill",
      filePath: `/skills/${name}/SKILL.md`,
      baseDir: `/skills/${name}`,
      source: overrides?.source ?? "user",
      disableModelInvocation: false,
    },
    frontmatter: {},
    metadata: overrides?.requiresBins
      ? { requires: { bins: overrides.requiresBins } }
      : undefined,
  };
}

describe("shouldIncludeSkill", () => {
  it("returns false when enabled is explicitly false", () => {
    const entry = makeEntry();
    const config: OpenClawConfig = {
      skills: { entries: { "test-skill": { enabled: false } } },
    } as OpenClawConfig;
    expect(shouldIncludeSkill({ entry, config })).toBe(false);
  });

  it("returns true when enabled is explicitly true, even with unmet requires.bins", () => {
    const entry = makeEntry({ requiresBins: ["nonexistent-binary-xyz"] });
    const config: OpenClawConfig = {
      skills: { entries: { "test-skill": { enabled: true } } },
    } as OpenClawConfig;
    expect(shouldIncludeSkill({ entry, config })).toBe(true);
  });

  it("returns true when enabled is explicitly true without any requires", () => {
    const entry = makeEntry();
    const config: OpenClawConfig = {
      skills: { entries: { "test-skill": { enabled: true } } },
    } as OpenClawConfig;
    expect(shouldIncludeSkill({ entry, config })).toBe(true);
  });

  it("falls through to runtime eligibility when enabled is not set", () => {
    // A skill requiring a nonexistent binary should be excluded when
    // there is no explicit enabled override.
    const entry = makeEntry({ requiresBins: ["nonexistent-binary-xyz"] });
    const config: OpenClawConfig = {
      skills: { entries: { "test-skill": {} } },
    } as OpenClawConfig;
    expect(shouldIncludeSkill({ entry, config })).toBe(false);
  });

  it("falls through to runtime eligibility when no skill config exists", () => {
    const entry = makeEntry({ requiresBins: ["nonexistent-binary-xyz"] });
    expect(shouldIncludeSkill({ entry })).toBe(false);
  });
});
