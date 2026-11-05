import { describe, expect, it } from "vitest";
import { applyXaiRuntimeModelCompat } from "./runtime-model-compat.js";

function expectReasoning(
  id: string,
  efforts: string[],
  levels: Array<string | null>,
  listed?: string[],
) {
  const model = applyXaiRuntimeModelCompat({
    id,
    provider: "xai",
    reasoning: true,
    ...(listed ? { compat: { supportedReasoningEfforts: listed } } : {}),
  });
  expect(model.compat).toMatchObject({
    supportsReasoningEffort: true,
    supportedReasoningEfforts: efforts,
  });
  const [off, minimal, low, medium, high, xhigh] = levels;
  expect(model.thinkingLevelMap).toEqual({ off, minimal, low, medium, high, xhigh });
}

const unsupportedLevels = {
  off: undefined,
  minimal: null,
  low: null,
  medium: null,
  high: null,
  xhigh: null,
};

describe("xai runtime model compat", () => {
  it("maps OpenClaw thinking levels to xAI efforts for reasoning-capable models", () => {
    expectReasoning(
      "grok-4.3",
      ["none", "low", "medium", "high"],
      ["none", "low", "low", "medium", "high", "high"],
    );
  });

  it.each(["grok-4.8", "grok-4.7", "grok-4.6"])("preserves %s xhigh reasoning", (id) => {
    expectReasoning(
      id,
      ["low", "medium", "high", "xhigh"],
      [null, "low", "low", "medium", "high", "xhigh"],
    );
  });

  it("maps Grok 4.5 thinking levels to its supported reasoning efforts", () => {
    expectReasoning(
      "grok-4.5",
      ["low", "medium", "high"],
      [null, "low", "low", "medium", "high", "high"],
    );
  });

  it("suppresses reasoning efforts for non-reasoning models", () => {
    const model = applyXaiRuntimeModelCompat({
      id: "grok-4-fast-non-reasoning",
      provider: "xai",
      reasoning: false,
    });
    expect(model.thinkingLevelMap).toEqual(unsupportedLevels);
  });

  it("does not advertise configurable reasoning effort for older xAI reasoning models", () => {
    const model = applyXaiRuntimeModelCompat({
      id: "grok-4.20-0309-reasoning",
      provider: "xai",
      reasoning: true,
    });
    expect(model.compat).toMatchObject({ supportsReasoningEffort: false });
    expect(model.thinkingLevelMap).toEqual(unsupportedLevels);
  });

  it("sends none for off only when the listed efforts include it", () => {
    expectReasoning(
      "grok-4.20-0309-reasoning",
      ["none", "low", "high"],
      ["none", "low", "low", "low", "high", "high"],
      ["high", "none", "low", "unknown"],
    );
  });
});
