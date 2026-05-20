import { describe, expect, it } from "vitest";
import { createModelRouter } from "./model-router.js";

describe("createModelRouter", () => {
  it("prefers explicit model over defaults", () => {
    const router = createModelRouter({ default: "sonnet-4.6" });
    expect(router.resolve("llm", "gpt-5.5")).toBe("gpt-5.5");
  });

  it("uses default for llm steps", () => {
    const router = createModelRouter({ default: "sonnet-4.6" });
    expect(router.resolve("llm")).toBe("sonnet-4.6");
  });

  it("returns undefined for unsupported step kinds", () => {
    const router = createModelRouter({ default: "sonnet-4.6" });
    expect(router.resolve("notification")).toBeUndefined();
  });
});
