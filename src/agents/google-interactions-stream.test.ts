import type { Model } from "@openclaw/ai/types";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configureAiTransportHost } from "../../packages/ai/src/host.js";
import { streamSimpleGoogleInteractions } from "../../packages/ai/src/providers/google-interactions.js";
import { classifyFailoverSignalCore } from "./failover/classify-core.js";
import { shouldRetryFailoverSignal } from "./failover/retry-evidence.js";

describe("Google Interactions stream recovery", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    configureAiTransportHost({});
  });

  it.each(["EOF", "[DONE]"])(
    "keeps partial replies retryable after %s without completion",
    async (ending) => {
      const model: Model<"google-interactions"> = {
        id: "gemini-3-flash-preview",
        name: "Gemini 3 Flash",
        api: "google-interactions",
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com/v1beta",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128_000,
        maxTokens: 8_192,
      };
      const payload =
        'data: {"event_type":"step.delta","delta":{"type":"text","text":"Partial reply"}}\n\n' +
        (ending === "[DONE]" ? "data: [DONE]\n\n" : "");
      configureAiTransportHost({});
      vi.stubGlobal(
        "fetch",
        vi.fn(
          async () =>
            new Response(payload, {
              headers: { "Content-Type": "text/event-stream" },
            }),
        ),
      );

      const result = await streamSimpleGoogleInteractions(
        model,
        {
          messages: [{ role: "user", content: "Hello", timestamp: 0 }],
        },
        { apiKey: "test-key" },
      ).result();

      expect(result.stopReason).toBe("error");
      expect(result.content).toEqual([{ type: "text", text: "Partial reply" }]);
      const signal = {
        provider: result.provider,
        message: result.errorMessage,
        code: result.errorCode,
        errorType: result.errorType,
      };
      const classification = classifyFailoverSignalCore(signal);
      expect({
        classification,
        retryable: shouldRetryFailoverSignal({ classification, signal }),
      }).toEqual({
        classification: { kind: "reason", reason: "timeout" },
        retryable: true,
      });
      expect(result).toMatchObject({
        errorCode: "STREAM_INCOMPLETE",
        errorType: "google_incomplete_stream",
      });
    },
  );
});
