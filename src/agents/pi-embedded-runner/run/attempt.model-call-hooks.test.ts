import { describe, expect, it } from "vitest";
import { buildBeforeModelCallEvent, buildModelCallId } from "./attempt.js";

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

  it("omits optional fields when they are not provided", () => {
    const event = buildBeforeModelCallEvent({
      runId: "run-3",
      sessionId: "session-3",
      provider: "openai",
      model: "gpt-5.4",
      callId: "run-3-1",
      requestMessages: [],
    });

    expect(event).toEqual({
      runId: "run-3",
      sessionId: "session-3",
      provider: "openai",
      model: "gpt-5.4",
      callId: "run-3-1",
      requestMessages: [],
    });
    expect(Object.keys(event)).not.toContain("api");
    expect(Object.keys(event)).not.toContain("systemPrompt");
  });
});

describe("buildModelCallId", () => {
  it("includes session identity so retries under the same runId stay unique", () => {
    expect(
      buildModelCallId({
        runId: "run-1",
        sessionId: "session-a",
        sequence: 1,
      }),
    ).toBe("run-1-session-a-1");
    expect(
      buildModelCallId({
        runId: "run-1",
        sessionId: "session-b",
        sequence: 1,
      }),
    ).toBe("run-1-session-b-1");
  });
});
