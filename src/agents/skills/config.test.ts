import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createCanonicalFixtureSkill } from "../skills.test-helpers.js";
import { shouldIncludeSkill } from "./config.js";
import type { SkillEntry } from "./types.js";

function createFixtureEntry(params: {
  name: string;
  metadata?: SkillEntry["metadata"];
}): SkillEntry {
  return {
    skill: createCanonicalFixtureSkill({
      name: params.name,
      description: "test skill",
      filePath: `/tmp/${params.name}/SKILL.md`,
      baseDir: `/tmp/${params.name}`,
      source: "openclaw-workspace",
    }),
    frontmatter: {},
    metadata: params.metadata,
  };
}

describe("shouldIncludeSkill", () => {
  it("includes a basic skill with no requirements", () => {
    const entry = createFixtureEntry({ name: "basic" });
    expect(shouldIncludeSkill({ entry })).toBe(true);
  });

  it("excludes a disabled skill", () => {
    const entry = createFixtureEntry({ name: "disabled" });
    const config: OpenClawConfig = {
      skills: { entries: { disabled: { enabled: false } } },
    };
    expect(shouldIncludeSkill({ entry, config })).toBe(false);
  });

  it("excludes a skill with unmet binary requirement", () => {
    const entry = createFixtureEntry({
      name: "needs-bin",
      metadata: { requires: { bins: ["nonexistent-bin-xyz"] } },
    });
    expect(shouldIncludeSkill({ entry })).toBe(false);
  });

  it("includes a skill with unmet binary requirement when persist is set in config", () => {
    const entry = createFixtureEntry({
      name: "persist-config",
      metadata: { requires: { bins: ["nonexistent-bin-xyz"] } },
    });
    const config: OpenClawConfig = {
      skills: { entries: { "persist-config": { persist: true } } },
    };
    expect(shouldIncludeSkill({ entry, config })).toBe(true);
  });

  it("includes a skill with unmet binary requirement when persist is set in metadata", () => {
    const entry = createFixtureEntry({
      name: "persist-meta",
      metadata: { persist: true, requires: { bins: ["nonexistent-bin-xyz"] } },
    });
    expect(shouldIncludeSkill({ entry })).toBe(true);
  });

  it("includes a skill with unmet env requirement when persist is set", () => {
    const entry = createFixtureEntry({
      name: "persist-env",
      metadata: { persist: true, requires: { env: ["MISSING_ENV_VAR_XYZ"] } },
    });
    expect(shouldIncludeSkill({ entry })).toBe(true);
  });

  it("includes a skill with unmet config requirement when persist is set", () => {
    const entry = createFixtureEntry({
      name: "persist-config-req",
      metadata: { persist: true, requires: { config: ["nonexistent.config.path"] } },
    });
    expect(shouldIncludeSkill({ entry })).toBe(true);
  });

  it("still excludes a disabled skill even when persist is set", () => {
    const entry = createFixtureEntry({
      name: "disabled-persist",
      metadata: { persist: true },
    });
    const config: OpenClawConfig = {
      skills: { entries: { "disabled-persist": { enabled: false, persist: true } } },
    };
    expect(shouldIncludeSkill({ entry, config })).toBe(false);
  });

  it("excludes OS-mismatched skill even when persist is set", () => {
    const mismatchedOs = process.platform === "darwin" ? "linux" : "darwin";
    const entry = createFixtureEntry({
      name: "wrong-os",
      metadata: { persist: true, os: [mismatchedOs] },
    });
    expect(shouldIncludeSkill({ entry })).toBe(false);
  });
});
