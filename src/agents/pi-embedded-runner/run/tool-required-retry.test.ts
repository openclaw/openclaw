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
      disableTools: false,
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
      disableTools: false,
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
      disableTools: false,
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
      disableTools: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(false);
  });

  it("does not classify tool-help questions as tool-required execution tasks", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "What command should I run to inspect logs in this repo?",
      assistantTexts: ["I'll explain which command to use and why."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(false);
  });

  it("uses latest assistant chunk for ack-only detection", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Run tests and fix this file in the repo.",
      assistantTexts: ["I'll do that.", "I ran tests and updated src/app.ts."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: false,
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

  it("does not classify imperative tool-help prompts as execution tasks", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Explain the command to inspect logs in this repo.",
      assistantTexts: ["I'll explain which command to use and why."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(false);
  });

  it("does not retry when tools are disabled for llm-only runs", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Run this test and inspect the logs.",
      assistantTexts: ["Acknowledged. I'll run this now and report back."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: true,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(false);
  });

  it("does retry execution prompts that start with 'show me'", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Show me the failing tests in this repo and fix the file.",
      assistantTexts: ["Acknowledged. I'll do that now."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(true);
  });

  it("does retry execution prompts that start with 'can you show me'", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Can you show me the failing tests in this repo and fix the file?",
      assistantTexts: ["Acknowledged. I'll do that now."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(true);
  });

  it("does not classify 'how to' guidance questions as execution tasks", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "How to run tests in this repo?",
      assistantTexts: ["I'll explain how to run tests."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(false);
  });

  it("does retry ack-only text that mentions output before doing work", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Run tests, inspect output, and fix the file in this repo.",
      assistantTexts: ["I'll inspect the output and fix the file now."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(true);
  });

  it("does retry ack-only text that says it will be fixed", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Run tests and fix the file in this repo.",
      assistantTexts: ["Acknowledged, I'll get this fixed now."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(true);
  });

  it("does not classify mixed execution prompts containing 'how to' as help-only", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Run tests and show how to fix the file in this repo.",
      assistantTexts: ["Acknowledged. I'll do that now."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(true);
  });

  it("does not classify 'could you explain how to' guidance prompts as execution tasks", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "Could you explain how to run tests in this repo?",
      assistantTexts: ["I'll explain how to run tests in this repo."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(false);
  });

  it("does not classify 'how can we' guidance prompts as execution tasks", () => {
    const shouldRetry = shouldRetryToolRequiredToolless({
      provider: "openai-codex",
      prompt: "How can we inspect logs in this repo?",
      assistantTexts: ["I'll explain how we can inspect logs in this repo."],
      lastAssistant: { stopReason: "end_turn", content: [] } as never,
      toolMetas: [],
      didSendViaMessagingTool: false,
      hasClientToolCall: false,
      disableTools: false,
      promptError: null,
      aborted: false,
      timedOut: false,
      timedOutDuringCompaction: false,
    });

    expect(shouldRetry).toBe(false);
  });
});
