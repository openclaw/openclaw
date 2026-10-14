import { describe, expect, it } from "vitest";
import {
  captureAnthropicRequest,
  registerParityHostLifecycle,
} from "./provider-transport-parity.test-support.js";

// Rows from Anthropic's model listing carry the capabilities it advertised; both
// request builders must follow them instead of the model-id rules.
function listedModel(id: string, claudeCapabilities: Record<string, boolean>) {
  return {
    id,
    params: { claudeCapabilities },
    thinkingLevelMap: {
      xhigh: claudeCapabilities.xhighEffort ? "xhigh" : null,
      max: claudeCapabilities.maxEffort ? "max" : null,
    },
  };
}

describe("Anthropic listed capabilities transport parity", () => {
  registerParityHostLifecycle();

  it("shapes an unknown listed model from its advertised capabilities", async () => {
    const model = listedModel("claude-sonnet-9", {
      adaptiveThinking: true,
      disabledThinking: true,
      xhighEffort: true,
      maxEffort: true,
    });
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model,
        reasoning: "xhigh",
        temperature: 0.2,
      });
      expect(payload.thinking).toMatchObject({ type: "adaptive" });
      expect(payload.output_config).toEqual({ effort: "xhigh" });
      expect(payload).not.toHaveProperty("temperature");
    }
  });

  it("uses budget thinking when the listing withholds adaptive support", async () => {
    const model = listedModel("claude-sonnet-4-6", {
      adaptiveThinking: false,
      xhighEffort: false,
      maxEffort: false,
    });
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model,
        reasoning: "high",
      });
      expect(payload.thinking).toMatchObject({ type: "enabled" });
      expect(payload).not.toHaveProperty("output_config");
    }
  });

  it("keeps thinking on when the listing rejects disabled thinking", async () => {
    const model = listedModel("claude-zephyr-1", {
      adaptiveThinking: true,
      disabledThinking: false,
      xhighEffort: true,
      maxEffort: true,
    });
    for (const implementation of ["provider", "transport"] as const) {
      const { payload } = await captureAnthropicRequest(implementation, {
        model,
        reasoning: "off",
      });
      expect(payload.thinking).toMatchObject({ type: "adaptive" });
      expect(payload.output_config).toEqual({ effort: "low" });
    }
  });
});
