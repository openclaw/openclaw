import { describe, expect, it } from "vitest";
import { buildBeforeModelCallEvent } from "./attempt.js";

describe("buildBeforeModelCallEvent", () => {
  it("includes the composed system prompt with the provider request messages", () => {
    const requestMessages = [{ role: "user", content: "hello" }];

    expect(
      buildBeforeModelCallEvent({
        runId: "run-1",
        sessionId: "session-1",
        provider: "bailian",
        model: "qwen-plus",
        api: "openai-chat",
        callId: "run-1-1",
        systemPrompt: "You are a precise system.",
        requestMessages,
      }),
    ).toEqual({
      runId: "run-1",
      sessionId: "session-1",
      provider: "bailian",
      model: "qwen-plus",
      api: "openai-chat",
      callId: "run-1-1",
      systemPrompt: "You are a precise system.",
      requestMessages,
    });
  });

  it("preserves the exact requestMessages payload for downstream hook consumers", () => {
    const requestMessages = [
      { role: "user", content: "hello" },
      { role: "assistant", content: [{ type: "tool_use", id: "tool-1", name: "read" }] },
    ];

    const event = buildBeforeModelCallEvent({
      runId: "run-2",
      sessionId: "session-2",
      provider: "openai",
      model: "gpt-5.4",
      api: "openai-chat",
      callId: "run-2-1",
      requestMessages,
    });

    expect(event.requestMessages).toBe(requestMessages);
    expect(event.systemPrompt).toBeUndefined();
  });
});
