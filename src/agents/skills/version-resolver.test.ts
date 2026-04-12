// RI-014 version-resolver tests
// Covers: groupSkillEntriesByName, resolveSkillVariant selection precedence,
// and compareSemver ordering.

import { describe, it, expect } from "vitest";
import type { Skill } from "@mariozechner/pi-coding-agent";
import {
  compareSemver,
  groupSkillEntriesByName,
  resolveSkillVariant,
  type AssignedVariantLike,
} from "./version-resolver.js";
import type { OpenClawSkillMetadata, SkillEntry } from "./types.js";

function makeSkill(name: string, filePath = `/skills/${name}/SKILL.md`): Skill {
  return {
    name,
    description: `${name} description`,
    filePath,
    baseDir: filePath.replace(/\/SKILL\.md$/, ""),
  } as unknown as Skill;
}

function entry(
  name: string,
  metadata?: OpenClawSkillMetadata,
): SkillEntry {
  return {
    skill: makeSkill(name, `/skills/${name}-${metadata?.variantId ?? "plain"}/SKILL.md`),
    frontmatter: {},
    metadata,
  };
}

describe("compareSemver", () => {
  it("orders major → minor → patch", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compareSemver("1.2.0", "1.1.9")).toBeGreaterThan(0);
    expect(compareSemver("1.1.1", "1.1.1")).toBe(0);
  });

  it("treats non-semver as 0.0.0", () => {
    expect(compareSemver("garbage", "0.0.1")).toBeLessThan(0);
    expect(compareSemver("1.2.3", "not-a-version")).toBeGreaterThan(0);
  });
});

describe("groupSkillEntriesByName", () => {
  it("collapses variants of the same logical skill into one bucket", () => {
    const a = entry("task-decomposer", { version: "1.0.0", variantId: "control" });
    const b = entry("task-decomposer", { version: "1.1.0", variantId: "v2" });
    const c = entry("other-skill", { version: "1.0.0" });
    const groups = groupSkillEntriesByName([a, b, c]);
    expect(groups.size).toBe(2);
    expect(groups.get("task-decomposer")?.length).toBe(2);
    expect(groups.get("other-skill")?.length).toBe(1);
  });
});

describe("resolveSkillVariant", () => {
  it("returns the single entry when bucket has only one", () => {
    const only = entry("skill-x", { version: "1.0.0" });
    const result = resolveSkillVariant([only], null);
    expect(result.entry).toBe(only);
    expect(result.reason).toBe("first-entry");
  });

  it("returns control when no assignment and multiple entries", () => {
    const control = entry("skill-x", { version: "1.0.0", variantId: "control" });
    const v2 = entry("skill-x", { version: "2.0.0", variantId: "v2" });
    const result = resolveSkillVariant([control, v2], null);
    expect(result.entry).toBe(control);
    expect(result.reason).toBe("control-entry");
  });

  it("returns control when no variantId is set on one of the entries", () => {
    const plain = entry("skill-x", { version: "1.0.0" });
    const v2 = entry("skill-x", { version: "2.0.0", variantId: "v2" });
    const result = resolveSkillVariant([plain, v2], null);
    expect(result.entry).toBe(plain);
    expect(result.reason).toBe("control-entry");
  });

  it("picks variant-and-version match when both are present", () => {
    const a = entry("skill-x", { version: "1.0.0", variantId: "control" });
    const b = entry("skill-x", { version: "2.0.0", variantId: "v2" });
    const assigned: AssignedVariantLike = {
      variant_id: "v2",
      skill_version: "2.0.0",
      experiment_id: "exp-1",
      is_control: false,
    };
    const result = resolveSkillVariant([a, b], assigned);
    expect(result.entry).toBe(b);
    expect(result.reason).toBe("variant-and-version-match");
  });

  it("falls back to variant-only match when version differs", () => {
    const a = entry("skill-x", { version: "1.0.0", variantId: "control" });
    const b = entry("skill-x", { version: "1.5.0", variantId: "v2" });
    const assigned: AssignedVariantLike = {
      variant_id: "v2",
      skill_version: "2.0.0", // doesn't match the 1.5.0 on disk
      experiment_id: "exp-1",
      is_control: false,
    };
    const result = resolveSkillVariant([a, b], assigned);
    expect(result.entry).toBe(b);
    expect(result.reason).toBe("variant-only-match");
  });

  it("falls back to version-only match when variant is phantom", () => {
    const a = entry("skill-x", { version: "1.0.0", variantId: "control" });
    const b = entry("skill-x", { version: "2.0.0", variantId: "experimental" });
    const assigned: AssignedVariantLike = {
      variant_id: "phantom",
      skill_version: "2.0.0",
      experiment_id: "exp-1",
      is_control: false,
    };
    const result = resolveSkillVariant([a, b], assigned);
    expect(result.entry).toBe(b);
    expect(result.reason).toBe("version-only-match");
  });

  it("falls through to control when assigned has no match at all", () => {
    const a = entry("skill-x", { version: "1.0.0", variantId: "control" });
    const b = entry("skill-x", { version: "2.0.0", variantId: "v2" });
    const assigned: AssignedVariantLike = {
      variant_id: "phantom",
      skill_version: "9.9.9",
      experiment_id: "exp-1",
      is_control: false,
    };
    const result = resolveSkillVariant([a, b], assigned);
    expect(result.entry).toBe(a);
    expect(result.reason).toBe("control-entry");
  });

  it("picks highest semver when no control entry exists", () => {
    const a = entry("skill-x", { version: "1.0.0", variantId: "v1" });
    const b = entry("skill-x", { version: "2.3.0", variantId: "v2" });
    const c = entry("skill-x", { version: "1.5.0", variantId: "v1.5" });
    const result = resolveSkillVariant([a, b, c], null);
    expect(result.entry).toBe(b);
    expect(result.reason).toBe("highest-version");
  });

  it("ignores assignment marked is_control and picks control entry", () => {
    const a = entry("skill-x", { version: "1.0.0", variantId: "control" });
    const b = entry("skill-x", { version: "2.0.0", variantId: "v2" });
    const assigned: AssignedVariantLike = {
      variant_id: "control",
      skill_version: "",
      experiment_id: null,
      is_control: true,
    };
    const result = resolveSkillVariant([a, b], assigned);
    expect(result.entry).toBe(a);
    expect(result.reason).toBe("control-entry");
  });

  it("throws on empty bucket", () => {
    expect(() => resolveSkillVariant([], null)).toThrow(/empty bucket/);
  });
});
