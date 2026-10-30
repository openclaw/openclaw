import { describe, expect, it } from "vitest";
import { prepareFlexProcessingParams } from "./flex-processing.js";

const directModel = {
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};
const prepare = (
  extraParams: Record<string, unknown>,
  thinkingLevel = "high",
  model = directModel,
) => prepareFlexProcessingParams({ model, thinkingLevel, extraParams });

describe("prepared Flex Processing requests", () => {
  it.each(["high", "xhigh"])("selects Flex for an opted-in %s request", (thinking) => {
    const prepared = prepare({ flexProcessing: true }, thinking);
    expect(prepared.extraParams).toEqual({ serviceTier: "flex" });
    expect(prepared.isFlexProcessing()).toBe(true);
  });

  it.each(["off", "minimal", "low", "medium", "adaptive"])(
    "does not automatically select Flex for %s reasoning",
    (thinking) => {
      const prepared = prepare({ flexProcessing: true }, thinking);
      expect(prepared.extraParams).toEqual({});
      expect(prepared.isFlexProcessing()).toBe(false);
    },
  );

  it.each(["off", "minimal", "low", "medium", "adaptive"])(
    "uses the opted-in policy for an explicitly authored Flex tier at %s reasoning",
    (thinking) => {
      const prepared = prepare({ flexProcessing: true, serviceTier: "flex" }, thinking);
      expect(prepared.isFlexProcessing()).toBe(true);
    },
  );

  it.each(["eu", "us"])("supports the official %s regional endpoint", (region) => {
    const prepared = prepare({ flexProcessing: true }, "high", {
      ...directModel,
      baseUrl: `https://${region}.api.openai.com/v1`,
    });
    expect(prepared.extraParams).toEqual({ serviceTier: "flex" });
    expect(prepared.isFlexProcessing()).toBe(true);
  });

  it.each([
    { provider: "openai", api: "openai-completions", baseUrl: directModel.baseUrl },
    { ...directModel, baseUrl: "https://proxy.example/v1" },
    { ...directModel, baseUrl: "https://api.openai.com.example/v1" },
    { ...directModel, baseUrl: "https://chatgpt.com/backend-api" },
    { ...directModel, baseUrl: "invalid endpoint" },
    { ...directModel, baseUrl: "http://api.openai.com/v1" },
  ])("keeps ordinary policy for the unsupported route $api/$baseUrl", (model) => {
    const prepared = prepare({ flexProcessing: true }, "high", model);
    expect(prepared.extraParams).toEqual({});
    expect(prepared.isFlexProcessing()).toBe(false);
  });

  it("leaves another provider's custom parameter alone", () => {
    const prepared = prepare({ flexProcessing: true }, "high", {
      ...directModel,
      provider: "custom",
    });
    expect(prepared.extraParams).toEqual({ flexProcessing: true });
    expect(prepared.isFlexProcessing()).toBe(false);
  });

  it.each(["default", "auto", "priority", "ultrafast", "invalid"])(
    "honors a prepared %s tier override instead of the inherited Flex option",
    (serviceTier) => {
      const prepared = prepare({ flexProcessing: true, serviceTier });
      expect(prepared.extraParams).toEqual({ serviceTier });
      expect(prepared.isFlexProcessing()).toBe(false);
    },
  );

  it.each(["serviceTier", "service_tier"])("normalizes the effective %s alias", (key) => {
    const prepared = prepare({ flexProcessing: true, [key]: "FLEX" });
    expect(prepared.isFlexProcessing()).toBe(true);
    expect(prepared.extraParams).not.toHaveProperty("flexProcessing");
  });

  it("tracks live speed overrides with the same precedence as provider requests", () => {
    let fastMode: boolean | "ultrafast" | undefined;
    const prepared = prepare({
      flexProcessing: true,
      serviceTier: "flex",
      fastMode: () => fastMode,
    });
    expect(prepared.isFlexProcessing()).toBe(true);
    for (const next of [true, false, "ultrafast"] as const) {
      fastMode = next;
      expect(prepared.isFlexProcessing()).toBe(false);
    }
    fastMode = undefined;
    expect(prepared.isFlexProcessing()).toBe(true);
  });

  it("preserves explicitly authored Flex without enabling the runtime opt-in", () => {
    const prepared = prepare({ serviceTier: "flex" });
    expect(prepared.extraParams).toEqual({ serviceTier: "flex" });
    expect(prepared.isFlexProcessing()).toBe(false);
  });
});
