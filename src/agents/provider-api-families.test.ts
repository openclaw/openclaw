import { describe, expect, it } from "vitest";
import { isGptResponsesFamily } from "./provider-api-families.js";

describe("provider api families", () => {
  it.each([
    "openai-completions",
    "openai-responses",
    "openai-codex-responses",
    "azure-openai-responses",
  ])("classifies %s as a GPT Responses-family API", (api) => {
    expect(isGptResponsesFamily(api)).toBe(true);
  });

  it("rejects unrelated APIs", () => {
    expect(isGptResponsesFamily("anthropic-messages")).toBe(false);
    expect(isGptResponsesFamily(undefined)).toBe(false);
  });
});
