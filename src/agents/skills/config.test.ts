import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { shouldIncludeSkill } from "./config.js";
import type { SkillEntry } from "./types.js";

vi.mock("../../shared/config-eval.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../shared/config-eval.js")>()),
  hasBinary: vi.fn().mockReturnValue(false),
}));

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
    // hasBinary is mocked to return false, so requires.bins rejects
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
