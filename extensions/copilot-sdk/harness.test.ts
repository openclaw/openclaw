import { describe, expect, it } from "vitest";
import { createCopilotSdkAgentHarness } from "./harness.js";

describe("createCopilotSdkAgentHarness", () => {
  it("returns an unadvertised placeholder harness", () => {
    const harness = createCopilotSdkAgentHarness();

    expect(harness.id).toBe("copilot-sdk");
    expect(harness.label).toBe("GitHub Copilot SDK");
    expect(
      harness.supports({ provider: "openai", modelId: "gpt-5.5", requestedRuntime: "auto" }),
    ).toEqual({
      supported: false,
      reason: "copilot-sdk scaffold is not implemented yet",
    });
    expect(
      harness.supports({
        provider: "anthropic",
        modelId: "claude-sonnet-4.5",
        requestedRuntime: "pi",
      }),
    ).toEqual({
      supported: false,
      reason: "copilot-sdk scaffold is not implemented yet",
    });
  });
});
