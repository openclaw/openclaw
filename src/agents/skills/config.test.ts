import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { shouldIncludeSkill } from "./config.js";
import type { SkillEntry } from "./types.js";

function makeEntry(overrides?: Partial<SkillEntry>): SkillEntry {
  return {
    skill: {
      name: "test-skill",
      source: "plugin",
      content: "",
      ...overrides?.skill,
    } as SkillEntry["skill"],
    frontmatter: {},
    metadata: {
      requires: { bins: ["missing-binary-xyz"] },
      ...overrides?.metadata,
    },
    ...overrides,
  };
}

describe("shouldIncludeSkill — enabled override (#32752)", () => {
  it("excludes skill when required binary is missing (default)", () => {
    const entry = makeEntry();
    expect(shouldIncludeSkill({ entry })).toBe(false);
  });

  it("force-disables skill with enabled: false", () => {
    const entry = makeEntry({ metadata: undefined });
    const config: OpenClawConfig = {
      skills: { entries: { "test-skill": { enabled: false } } },
    } as OpenClawConfig;
    expect(shouldIncludeSkill({ entry, config })).toBe(false);
  });

  it("force-enables skill with enabled: true even when binary is missing", () => {
    const entry = makeEntry();
    const config: OpenClawConfig = {
      skills: { entries: { "test-skill": { enabled: true } } },
    } as OpenClawConfig;
    expect(shouldIncludeSkill({ entry, config })).toBe(true);
  });

  it("includes skill with no requirements and no config override", () => {
    const entry = makeEntry({ metadata: undefined });
    expect(shouldIncludeSkill({ entry })).toBe(true);
  });

  it("respects allowBundled even with enabled: true for bundled skills", () => {
    const entry = makeEntry({
      skill: {
        name: "test-skill",
        source: "openclaw-bundled",
        content: "",
      } as SkillEntry["skill"],
    });
    const config: OpenClawConfig = {
      skills: {
        entries: { "test-skill": { enabled: true } },
        allowBundled: ["other-skill"],
      },
    } as unknown as OpenClawConfig;
    expect(shouldIncludeSkill({ entry, config })).toBe(false);
  });
});
