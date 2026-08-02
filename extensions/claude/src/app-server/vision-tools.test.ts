import { describe, expect, it } from "vitest";
import { filterToolsForVisionInputs, modelSupportsVision } from "./vision-tools.js";

describe("filterToolsForVisionInputs", () => {
  const TOOLS = [{ name: "read" }, { name: "image" }, { name: "bash" }];

  it("keeps the image tool when the model lacks native vision", () => {
    const out = filterToolsForVisionInputs(TOOLS, {
      modelHasVision: false,
      hasInboundImages: true,
    });
    expect(out.map((t) => t.name)).toEqual(["read", "image", "bash"]);
  });

  it("keeps the image tool when there are no inbound images even on a vision model", () => {
    const out = filterToolsForVisionInputs(TOOLS, {
      modelHasVision: true,
      hasInboundImages: false,
    });
    expect(out.map((t) => t.name)).toEqual(["read", "image", "bash"]);
  });

  it("drops the image tool only when both conditions hold", () => {
    const out = filterToolsForVisionInputs(TOOLS, {
      modelHasVision: true,
      hasInboundImages: true,
    });
    expect(out.map((t) => t.name)).toEqual(["read", "bash"]);
  });

  it("returns an empty array unchanged when there are no tools", () => {
    expect(
      filterToolsForVisionInputs([], { modelHasVision: true, hasInboundImages: true }),
    ).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const before = TOOLS.slice();
    filterToolsForVisionInputs(TOOLS, { modelHasVision: true, hasInboundImages: true });
    expect(TOOLS).toEqual(before);
  });
});

describe("modelSupportsVision", () => {
  it.each([
    "claude-sonnet-4-6",
    "claude-opus-4-7",
    "claude-3-5-sonnet-latest",
    "claude-3-5-haiku-20241022",
    "claude-3-7-sonnet-20250219",
    "claude-3-opus-20240229",
    "claude-haiku-4-5-20251001",
    "CLAUDE-SONNET-4-6",
  ])("recognizes %s as vision-capable", (modelId) => {
    expect(modelSupportsVision(modelId)).toBe(true);
  });

  it.each<string | undefined>([
    "claude-3-haiku-20240307",
    "gpt-5.5",
    "unknown-model",
    "",
    undefined,
  ])("returns false for %s", (modelId) => {
    expect(modelSupportsVision(modelId)).toBe(false);
  });
});
