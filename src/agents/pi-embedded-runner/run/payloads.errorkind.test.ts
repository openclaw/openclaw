import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { buildEmbeddedRunPayloads } from "./payloads.js";

describe("buildEmbeddedRunPayloads errorKind derivation", () => {
  const makeAssistant = (overrides: Partial<AssistantMessage>): AssistantMessage => ({
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "test-model",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 0,
    stopReason: "error",
    content: [],
    ...overrides,
  });

  it("derives errorKind billing from a 402 error", () => {
    const billingError =
      '{"type":"error","error":{"type":"billing_error","message":"402 payment required"}}';
    const lastAssistant = makeAssistant({ errorMessage: billingError });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:test",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    const errorPayload = payloads.find((p) => p.isError);
    expect(errorPayload?.errorKind).toBe("billing");
  });

  it("derives errorKind rate_limit from rate limit error", () => {
    const lastAssistant = makeAssistant({ errorMessage: "429 Too Many Requests" });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:test",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    const errorPayload = payloads.find((p) => p.isError);
    expect(errorPayload?.errorKind).toBe("rate_limit");
  });

  it("derives errorKind timeout from timeout error", () => {
    const lastAssistant = makeAssistant({ errorMessage: "Request timed out" });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:test",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    const errorPayload = payloads.find((p) => p.isError);
    expect(errorPayload?.errorKind).toBe("timeout");
  });

  it("derives errorKind context_overflow from context overflow error", () => {
    const lastAssistant = makeAssistant({ errorMessage: "context length exceeded" });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:test",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    const errorPayload = payloads.find((p) => p.isError);
    expect(errorPayload?.errorKind).toBe("context_overflow");
  });

  it("does not set errorKind when assistant did not error", () => {
    const lastAssistant = makeAssistant({
      stopReason: "stop",
      errorMessage: undefined,
      content: [{ type: "text", text: "Hello" }],
    });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["Hello"],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:test",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads.every((p) => p.errorKind === undefined)).toBe(true);
  });

  it("does not enqueue error payloads for non-error turns with stale errorMessage", () => {
    const lastAssistant = makeAssistant({
      stopReason: "stop",
      errorMessage: "500 Internal Server Error",
      content: [{ type: "text", text: "Recovered response" }],
    });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: ["Recovered response"],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:test",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads.find((p) => p.isError)).toBeUndefined();
    expect(payloads.some((p) => p.text === "Recovered response")).toBe(true);
  });

  it("emits one friendly payload for content-only role ordering errors", () => {
    const lastAssistant = makeAssistant({
      errorMessage: "",
      content: [{ type: "text", text: "400 Incorrect role information" }],
    });
    const payloads = buildEmbeddedRunPayloads({
      assistantTexts: [],
      toolMetas: [],
      lastAssistant,
      sessionKey: "session:test",
      inlineToolResultsAllowed: false,
      verboseLevel: "off",
      reasoningLevel: "off",
    });

    expect(payloads.filter((p) => p.text?.includes("Message ordering conflict"))).toHaveLength(1);
    expect(payloads.find((p) => p.isError)?.errorKind).toBe("role_ordering");
    expect(payloads.some((p) => p.text === "LLM request failed with an unknown error.")).toBe(
      false,
    );
  });
});
