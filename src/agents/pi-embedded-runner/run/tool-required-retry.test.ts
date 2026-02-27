import { describe, expect, it } from "vitest";
import {
  buildToolRequiredRetryPrompt,
  shouldRetryToolRequiredToolless,
} from "./tool-required-retry.js";

describe("tool-required retry guard", () => {
  it("retries codex acknowledgement-only text for tool-required prompts", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Run this test, inspect the output, and fix the file in this repo.",
      assistantTexts: ["Acknowledged. I'll run this now and report back."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(true);
  });

  it("does not retry when tools were actually used", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Run this test and fix the file.",
      assistantTexts: ["Acknowledged. I'll do that."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [{ toolName: "exec" }],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(false);
  });

  it("does not retry for normal non-tool replies", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "What is OpenClaw?",
      assistantTexts: ["OpenClaw is an open-source agent runtime."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(false);
  });

  it("does not treat marker fragments inside words as tool-required", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Explain the openclaw profile settings.",
      assistantTexts: ["I'll explain what this profile controls."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(false);
  });

  it("adds explicit no-ack instruction", () => {
    const prompt = buildToolRequiredRetryPrompt("Fix failing tests.");
    expect(prompt).toContain("do not send an acknowledgement-only response");
  });
});
