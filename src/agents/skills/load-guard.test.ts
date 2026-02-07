import type { Skill } from "@mariozechner/pi-coding-agent";
import { describe, expect, it, beforeEach } from "vitest";
import { registerSkillLoadGuard, getSkillLoadGuard, type SkillLoadGuard } from "./load-guard.js";

function makeSkill(name: string): Skill {
  return {
    name,
    baseDir: `/tmp/skills/${name}`,
    filePath: `/tmp/skills/${name}/SKILL.md`,
  } as Skill;
}

function makeSkillMap(...names: string[]): Map<string, Skill> {
  const m = new Map<string, Skill>();
  for (const n of names) m.set(n, makeSkill(n));
  return m;
}

describe("load-guard", () => {
  beforeEach(() => {
    // Ensure no guard is registered before each test.
    const existing = getSkillLoadGuard();
    if (existing) {
      // Force-clear by registering a noop then unregistering.
      const unreg = registerSkillLoadGuard({ evaluate: () => ({ blocked: [] }) });
      unreg();
    }
  });

  it("returns null when no guard is registered", () => {
    expect(getSkillLoadGuard()).toBeNull();
  });

  it("returns the registered guard", () => {
    const guard: SkillLoadGuard = {
      evaluate: () => ({ blocked: [] }),
    };
    registerSkillLoadGuard(guard);
    expect(getSkillLoadGuard()).toBe(guard);
  });

  it("unregister clears the guard", () => {
    const guard: SkillLoadGuard = {
      evaluate: () => ({ blocked: [] }),
    };
    const unregister = registerSkillLoadGuard(guard);
    expect(getSkillLoadGuard()).toBe(guard);
    unregister();
    expect(getSkillLoadGuard()).toBeNull();
  });

  it("evaluate returns blocked and warnings", () => {
    const guard: SkillLoadGuard = {
      evaluate: (skills) => ({
        blocked: Array.from(skills.keys()).filter((n) => n.startsWith("bad-")),
        warnings: Array.from(skills.keys())
          .filter((n) => n.startsWith("warn-"))
          .map((n) => ({ name: n, message: "suspicious" })),
      }),
    };
    registerSkillLoadGuard(guard);

    const skills = makeSkillMap("good-tool", "bad-crypto", "warn-network");
    const result = getSkillLoadGuard()!.evaluate(skills);

    expect(result.blocked).toEqual(["bad-crypto"]);
    expect(result.warnings).toEqual([{ name: "warn-network", message: "suspicious" }]);
  });
});
