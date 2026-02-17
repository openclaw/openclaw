import { describe, expect, it } from "vitest";
import { normalizeThinkLevelForProvider } from "./pi-embedded-helpers.js";

describe("normalizeThinkLevelForProvider", () => {
  it("keeps off for z.ai providers", () => {
    expect(normalizeThinkLevelForProvider({ provider: "zai", thinkLevel: "off" })).toBe("off");
  });

  it("collapses non-off levels to low for z.ai providers", () => {
    expect(normalizeThinkLevelForProvider({ provider: "zai", thinkLevel: "minimal" })).toBe("low");
    expect(normalizeThinkLevelForProvider({ provider: "z.ai", thinkLevel: "high" })).toBe("low");
    expect(normalizeThinkLevelForProvider({ provider: "z-ai", thinkLevel: "xhigh" })).toBe("low");
  });

  it("does not change non-zai providers", () => {
    expect(normalizeThinkLevelForProvider({ provider: "anthropic", thinkLevel: "high" })).toBe(
      "high",
    );
  });
});
