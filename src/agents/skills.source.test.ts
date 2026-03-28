import { describe, expect, it } from "vitest";
import { resolveSkillSource } from "./skills/source.js";

describe("resolveSkillSource", () => {
  it("prefers sourceInfo.source when present", () => {
    expect(
      resolveSkillSource({
        sourceInfo: { source: "openclaw-bundled" },
      } as never),
    ).toBe("openclaw-bundled");
  });

  it("returns unknown when neither source shape is present", () => {
    expect(resolveSkillSource({} as never)).toBe("unknown");
  });
});
