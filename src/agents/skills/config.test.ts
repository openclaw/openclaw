import { describe, expect, it } from "vitest";
import { isBundledSkillAllowed, resolveBundledAllowlist, type SkillEntry } from "./config.js";

function mockBundledEntry(name: string): SkillEntry {
  return {
    skill: { name, source: "openclaw-bundled", description: "" },
    frontmatter: {},
  };
}

function mockWorkspaceEntry(name: string): SkillEntry {
  return {
    skill: { name, source: "workspace", description: "" },
    frontmatter: {},
  };
}

describe("allowBundled", () => {
  describe("resolveBundledAllowlist", () => {
    it("returns undefined when allowBundled is not set", () => {
      expect(resolveBundledAllowlist({})).toBeUndefined();
      expect(resolveBundledAllowlist({ skills: {} })).toBeUndefined();
    });

    it("returns [] when allowBundled is empty array (block all bundled)", () => {
      const cfg = { skills: { allowBundled: [] } };
      expect(resolveBundledAllowlist(cfg)).toEqual([]);
    });

    it("returns normalized list when allowBundled has entries", () => {
      const cfg = { skills: { allowBundled: ["github", "slack"] } };
      expect(resolveBundledAllowlist(cfg)).toEqual(["github", "slack"]);
    });
  });

  describe("isBundledSkillAllowed", () => {
    it("allows all when allowlist is undefined", () => {
      const bundled = mockBundledEntry("any-bundled");
      expect(isBundledSkillAllowed(bundled, undefined)).toBe(true);
    });

    it("blocks all bundled when allowlist is empty array", () => {
      const bundled = mockBundledEntry("github");
      expect(isBundledSkillAllowed(bundled, [])).toBe(false);
    });

    it("allows non-bundled skills even when allowlist is empty", () => {
      const workspace = mockWorkspaceEntry("my-skill");
      expect(isBundledSkillAllowed(workspace, [])).toBe(true);
    });

    it("allows bundled skill only when listed", () => {
      const bundled = mockBundledEntry("github");
      expect(isBundledSkillAllowed(bundled, ["slack"])).toBe(false);
      expect(isBundledSkillAllowed(bundled, ["github"])).toBe(true);
    });
  });
});
