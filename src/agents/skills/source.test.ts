import { describe, expect, it } from "vitest";
import type { SkillSourceCompat } from "./types.js";
import { getSkillSource } from "./types.js";

function makeSkill(partial: Partial<SkillSourceCompat>): SkillSourceCompat {
  return {
    name: "demo",
    description: "demo",
    filePath: "/tmp/demo/SKILL.md",
    baseDir: "/tmp/demo",
    source: "openclaw-workspace",
    disableModelInvocation: false,
    ...partial,
  } as SkillSourceCompat;
}

describe("getSkillSource", () => {
  it("prefers the canonical top-level source field", () => {
    expect(
      getSkillSource(
        makeSkill({
          source: "openclaw-bundled",
          sourceInfo: { source: "openclaw-workspace" },
        }),
      ),
    ).toBe("openclaw-bundled");
  });

  it("falls back to legacy sourceInfo.source when source is absent", () => {
    expect(
      getSkillSource(
        makeSkill({
          source: undefined,
          sourceInfo: { source: "openclaw-bundled" },
        }),
      ),
    ).toBe("openclaw-bundled");
  });

  it("returns undefined when neither source shape is populated", () => {
    expect(
      getSkillSource(
        makeSkill({
          source: "",
          sourceInfo: {},
        }),
      ),
    ).toBeUndefined();
  });
});
