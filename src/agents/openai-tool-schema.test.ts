import { describe, expect, it } from "vitest";
import { resolvesToNativeOpenAIStrictTools } from "./openai-tool-schema.js";

describe("resolvesToNativeOpenAIStrictTools", () => {
  it("ignores non-string routing fields", () => {
    expect(
      resolvesToNativeOpenAIStrictTools(
        {
          provider: { value: "openai" },
          api: 123,
          baseUrl: false,
          id: ["gpt-5.4"],
          compat: { supportsStore: true },
        },
        "stream",
      ),
    ).toBe(false);
  });
});
