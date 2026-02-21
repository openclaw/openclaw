import { describe, expect, it, test } from "vitest";
import { isBundledSkillAllowed, resolveBundledAllowlist } from "./config.js";
import type { SkillEntry } from "./types.js";

/**
 * Helper: create a minimal bundled SkillEntry for testing.
 */
function bundledSkill(name: string): SkillEntry {
  return {
    skill: { name, source: "openclaw-bundled" } as SkillEntry["skill"],
    frontmatter: {},
  };
}

/**
 * Helper: create a minimal workspace (non-bundled) SkillEntry for testing.
 */
function workspaceSkill(name: string): SkillEntry {
  return {
    skill: { name, source: "workspace" } as SkillEntry["skill"],
    frontmatter: {},
  };
}

describe("resolveBundledAllowlist", () => {
  it("returns undefined when allowBundled is not set", () => {
    expect(resolveBundledAllowlist({})).toBeUndefined();
    expect(resolveBundledAllowlist(undefined)).toBeUndefined();
    expect(resolveBundledAllowlist({ skills: {} })).toBeUndefined();
  });

  it("returns undefined for null or non-array values", () => {
    expect(resolveBundledAllowlist({ skills: { allowBundled: null } } as any)).toBeUndefined();
    expect(resolveBundledAllowlist({ skills: { allowBundled: "web" } } as any)).toBeUndefined();
    expect(resolveBundledAllowlist({ skills: { allowBundled: 42 } } as any)).toBeUndefined();
  });

  it("returns a normal list for valid entries", () => {
    expect(resolveBundledAllowlist({ skills: { allowBundled: ["web", "pdf"] } } as any)).toEqual([
      "web",
      "pdf",
    ]);
  });

  it("trims whitespace from entries", () => {
    expect(
      resolveBundledAllowlist({ skills: { allowBundled: ["  web  ", "pdf "] } } as any),
    ).toEqual(["web", "pdf"]);
  });

  it("returns [] for an explicit empty array (not undefined)", () => {
    // Bug #21709: normalizeAllowlist([]) currently returns undefined instead of []
    const result = resolveBundledAllowlist({ skills: { allowBundled: [] } } as any);
    expect(result).toEqual([]);
  });

  it("returns [] when all entries normalize to empty strings", () => {
    // allowBundled: ["", "  "] → after trim + filter → [] → should still be []
    const result = resolveBundledAllowlist({
      skills: { allowBundled: ["", "  "] },
    } as any);
    expect(result).toEqual([]);
  });
});

describe("isBundledSkillAllowed", () => {
  const web = bundledSkill("web");
  const pdf = bundledSkill("pdf");
  const mySkill = workspaceSkill("my-custom-skill");

  it("allows all bundled skills when allowlist is undefined (not configured)", () => {
    expect(isBundledSkillAllowed(web, undefined)).toBe(true);
    expect(isBundledSkillAllowed(pdf, undefined)).toBe(true);
  });

  it("allows only listed bundled skills", () => {
    expect(isBundledSkillAllowed(web, ["web"])).toBe(true);
    expect(isBundledSkillAllowed(pdf, ["web"])).toBe(false);
  });

  it("always allows non-bundled (workspace) skills regardless of allowlist", () => {
    expect(isBundledSkillAllowed(mySkill, undefined)).toBe(true);
    expect(isBundledSkillAllowed(mySkill, ["web"])).toBe(true);
    expect(isBundledSkillAllowed(mySkill, [])).toBe(true);
  });

  it("blocks all bundled skills when allowlist is empty array", () => {
    // Bug #21709: isBundledSkillAllowed(entry, []) currently returns true
    // because it treats [] the same as undefined
    expect(isBundledSkillAllowed(web, [])).toBe(false);
    expect(isBundledSkillAllowed(pdf, [])).toBe(false);
  });

  it("blocks all bundled skills when allowlist contains only misspelled names", () => {
    // User typo: "wbe" instead of "web" — no bundled skill matches, so all are blocked.
    // This is correct allowlist behavior (fail closed), but the user gets no warning.
    expect(isBundledSkillAllowed(web, ["wbe"])).toBe(false);
    expect(isBundledSkillAllowed(pdf, ["wbe"])).toBe(false);
  });
});
