import { describe, expect, it } from "vitest";
import { classifyEmbeddedAgentRunResultForModelFallback } from "./result-fallback-classifier.js";

describe("classifyEmbeddedAgentRunResultForModelFallback delivery evidence", () => {
  it("does not fallback after tool activity when replay safety is missing", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "xai",
      model: "grok-composer-2.5-fast",
      result: {
        payloads: [],
        meta: {
          durationMs: 42,
          toolSummary: {
            tools: ["write"],
            calls: 1,
          },
        },
      },
    });

    expect(result).toBeNull();
  });

  it.each(["hasDirectlySentBlockReply", "hasBlockReplyPipelineOutput"] as const)(
    "does not fallback after delivered block reply evidence in %s",
    (deliveryEvidence) => {
      const result = classifyEmbeddedAgentRunResultForModelFallback({
        provider: "xai",
        model: "grok-composer-2.5-fast",
        result: {
          payloads: [],
          meta: {
            durationMs: 42,
            toolSummary: {
              tools: ["read"],
              calls: 1,
              hadFailure: false,
            },
          },
        },
        [deliveryEvidence]: true,
      });

      expect(result).toBeNull();
    },
  );
});
