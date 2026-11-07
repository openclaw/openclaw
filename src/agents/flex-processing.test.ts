import { describe, expect, it } from "vitest";
import { isFlexProcessingRequest } from "./flex-processing.js";

const directModel = {
  provider: "openai",
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
};
const isFlex = (extraParams: Record<string, unknown>, model = directModel) =>
  isFlexProcessingRequest({ model, extraParams });

describe("effective Flex Processing requests", () => {
  it.each(["serviceTier", "service_tier"])("follows the normalized %s tier", (key) => {
    expect(isFlex({ [key]: "FLEX" })).toBe(true);
    for (const tier of [undefined, "default", "auto", "priority", "ultrafast", "invalid"]) {
      expect(isFlex({ [key]: tier })).toBe(false);
    }
  });

  it.each([undefined, "https://eu.api.openai.com/v1", "https://us.api.openai.com/v1"])(
    "supports the official endpoint %s",
    (baseUrl) => {
      expect(
        isFlexProcessingRequest({
          model: { ...directModel, baseUrl },
          extraParams: { serviceTier: "flex" },
        }),
      ).toBe(true);
    },
  );

  it.each([
    { ...directModel, provider: "custom" },
    { ...directModel, api: "openai-completions" },
    { ...directModel, baseUrl: "https://proxy.example/v1" },
    { ...directModel, baseUrl: "https://api.openai.com.example/v1" },
    { ...directModel, baseUrl: "https://chatgpt.com/backend-api" },
    { ...directModel, baseUrl: "invalid endpoint" },
    { ...directModel, baseUrl: "http://api.openai.com/v1" },
  ])("keeps ordinary policy for $provider/$api/$baseUrl", (model) => {
    expect(isFlex({ serviceTier: "flex" }, model)).toBe(false);
  });

  it("tracks live speed overrides with the transport's tier precedence", () => {
    let fastMode: boolean | "ultrafast" | undefined;
    const extraParams = { serviceTier: "flex", fastMode: () => fastMode };
    expect(isFlex(extraParams)).toBe(true);
    for (const next of [true, false, "ultrafast"] as const) {
      fastMode = next;
      expect(isFlex(extraParams)).toBe(false);
    }
    fastMode = undefined;
    expect(isFlex(extraParams)).toBe(true);
  });
});
