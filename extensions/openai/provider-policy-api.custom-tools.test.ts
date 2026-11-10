import { describe, expect, it } from "vitest";
import { resolveModelRoutes } from "./provider-policy-api.js";

describe("OpenAI custom-tool runtime capability", () => {
  it.each([
    ["gpt-4.1-mini", false],
    ["openai/gpt-4.1-mini", false],
    ["gpt-4o", false],
    ["o3", false],
    ["ft:gpt-4.1-mini:example:custom:id", false],
    ["gpt-5-mini", true],
    ["gpt-5.4", true],
  ])("selects a custom-tool-compatible runtime for %s", (modelId, supportsCustomTools) => {
    const result = resolveModelRoutes({
      provider: "openai",
      modelId,
      configuredModel: {
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
      },
      env: {},
    });
    expect(result).toMatchObject({
      kind: "routes",
      defaultRuntimeId: supportsCustomTools ? "codex" : "openclaw",
    });
    if (result.kind !== "routes") {
      throw new Error("Expected a concrete OpenAI route");
    }
    expect(result.routes[0]?.runtimePolicy?.compatibleIds).toEqual(
      supportsCustomTools ? ["openclaw", "codex", "agentsapi"] : ["openclaw", "agentsapi"],
    );
  });

  it("chooses function tools before an older model's catalog route is resolved", () => {
    expect(
      resolveModelRoutes({ provider: "openai", modelId: "gpt-4.1-mini", env: {} }),
    ).toMatchObject({ kind: "indeterminate", defaultRuntimeId: "openclaw" });
  });
});
