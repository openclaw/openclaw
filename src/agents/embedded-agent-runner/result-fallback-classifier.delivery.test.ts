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

  it("does not fallback after a directly sent block reply with an error payload", () => {
    const result = classifyEmbeddedAgentRunResultForModelFallback({
      provider: "zai",
      model: "glm-5.1",
      hasDirectlySentBlockReply: true,
      result: {
        payloads: [
          {
            isError: true,
            text: '{"success":false,"code":"CE-011","message":"access denied"}',
          },
        ],
        meta: {
          durationMs: 42,
        },
      },
    });

    expect(result).toBeNull();
  });
});
