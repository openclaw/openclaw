import { describe, expect, it } from "vitest";
import type { ModelCompatConfig } from "../../config/types.models.js";
import { mapThinkingLevel } from "./utils.js";

describe("mapThinkingLevel", () => {
  it("returns undefined when model doesn't support reasoning_effort", () => {
    const compat: ModelCompatConfig = { supportsReasoningEffort: false };
    expect(mapThinkingLevel("low", compat)).toBeUndefined();
    expect(mapThinkingLevel("high", compat)).toBeUndefined();
    expect(mapThinkingLevel("off", compat)).toBeUndefined();
    expect(mapThinkingLevel(undefined, compat)).toBeUndefined();
  });

  it("returns level when model supports reasoning_effort", () => {
    const compat: ModelCompatConfig = { supportsReasoningEffort: true };
    expect(mapThinkingLevel("low", compat)).toBe("low");
    expect(mapThinkingLevel("high", compat)).toBe("high");
    expect(mapThinkingLevel("off", compat)).toBe("off");
  });

  it("returns level when compat is empty object", () => {
    const compat: ModelCompatConfig = {};
    expect(mapThinkingLevel("low", compat)).toBe("low");
    expect(mapThinkingLevel("high", compat)).toBe("high");
  });

  it("returns level when compat is undefined", () => {
    expect(mapThinkingLevel("low")).toBe("low");
    expect(mapThinkingLevel("high")).toBe("high");
  });

  it("handles undefined level with no compat restrictions", () => {
    expect(mapThinkingLevel(undefined)).toBe("off");
    expect(mapThinkingLevel(undefined, {})).toBe("off");
    expect(mapThinkingLevel(undefined, { supportsReasoningEffort: true })).toBe("off");
  });
});
