import { describe, expect, it } from "vitest";
import { isBundledSkillAllowed, resolveBundledAllowlist } from "./config.js";
import type { SkillEntry } from "./types.js";

function makeEntry(name: string, source: string): SkillEntry {
  return {
    skill: {
      name,
      description: `${name} skill`,
      filePath: `/skills/${name}/index.md`,
      baseDir: `/skills/${name}`,
      source,
      disableModelInvocation: false,
    },
    frontmatter: {},
  };
}

const bundledEntry = makeEntry("weather", "openclaw-bundled");
const otherBundledEntry = makeEntry("translate", "openclaw-bundled");
const workspaceEntry = makeEntry("my-tool", "workspace");

describe("isBundledSkillAllowed", () => {
  it("allows all skills when allowlist is undefined (not configured)", () => {
    expect(isBundledSkillAllowed(bundledEntry, undefined)).toBe(true);
    expect(isBundledSkillAllowed(workspaceEntry, undefined)).toBe(true);
  });

  it("blocks all bundled skills when allowlist is [] (explicitly empty)", () => {
    expect(isBundledSkillAllowed(bundledEntry, [])).toBe(false);
    expect(isBundledSkillAllowed(otherBundledEntry, [])).toBe(false);
  });

  it("does not block workspace skills when allowlist is []", () => {
    expect(isBundledSkillAllowed(workspaceEntry, [])).toBe(true);
  });

  it("allows only listed bundled skills", () => {
    const allowlist = ["weather"];
    expect(isBundledSkillAllowed(bundledEntry, allowlist)).toBe(true);
    expect(isBundledSkillAllowed(otherBundledEntry, allowlist)).toBe(false);
  });

  it("never blocks workspace skills regardless of allowlist", () => {
    expect(isBundledSkillAllowed(workspaceEntry, undefined)).toBe(true);
    expect(isBundledSkillAllowed(workspaceEntry, [])).toBe(true);
    expect(isBundledSkillAllowed(workspaceEntry, ["weather"])).toBe(true);
  });
});

describe("resolveBundledAllowlist", () => {
  it("returns undefined when allowBundled is not configured", () => {
    expect(resolveBundledAllowlist(undefined)).toBeUndefined();
    expect(resolveBundledAllowlist({})).toBeUndefined();
    expect(resolveBundledAllowlist({ skills: {} })).toBeUndefined();
  });

  it("returns [] when allowBundled is explicitly empty", () => {
    expect(resolveBundledAllowlist({ skills: { allowBundled: [] } })).toEqual([]);
  });

  it("returns normalized entries when allowBundled has values", () => {
    expect(
      resolveBundledAllowlist({ skills: { allowBundled: ["weather", " translate "] } }),
    ).toEqual(["weather", "translate"]);
  });
});
