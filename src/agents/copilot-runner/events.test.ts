import type { SessionEvent } from "@github/copilot-sdk";
import { describe, expect, it } from "vitest";
import {
  buildRunResult,
  createRunAccumulator,
  handleSessionEvent,
  type RunCallbacks,
} from "./events.js";

function fakeEvent(type: string, data: Record<string, unknown> = {}): SessionEvent {
  return {
    id: "test-id",
    timestamp: new Date().toISOString(),
    parentId: null,
    type,
    data,
  } as SessionEvent;
}

describe("createRunAccumulator", () => {
  it("initializes with empty state", () => {
    const acc = createRunAccumulator({ sessionId: "s1", model: "gpt-5.4", provider: "copilot" });
    expect(acc.text).toBe("");
    expect(acc.hasContent).toBe(false);
    expect(acc.toolCallCount).toBe(0);
    expect(acc.awaitingFirstDelta).toBe(true);
  });
});

describe("handleSessionEvent", () => {
  it("accumulates assistant.message_delta text", async () => {
    const acc = createRunAccumulator({ sessionId: "s1", model: "gpt-5.4", provider: "copilot" });
    const partials: string[] = [];
    const callbacks: RunCallbacks = {
      onPartialReply: (p) => {
        if (p.text) {
          partials.push(p.text);
        }
      },
      onAssistantMessageStart: () => {},
    };

    await handleSessionEvent(
      fakeEvent("assistant.message_delta", { deltaContent: "Hello " }),
      acc,
      callbacks,
    );
    await handleSessionEvent(
      fakeEvent("assistant.message_delta", { deltaContent: "world" }),
      acc,
      callbacks,
    );

    expect(acc.text).toBe("Hello world");
    expect(acc.hasContent).toBe(true);
    expect(partials).toEqual(["Hello ", "world"]);
  });

  it("fires onAssistantMessageStart on first delta only", async () => {
    const acc = createRunAccumulator({ sessionId: "s1", model: "gpt-5.4", provider: "copilot" });
    let startCount = 0;
    const callbacks: RunCallbacks = {
      onAssistantMessageStart: () => {
        startCount++;
      },
    };

    await handleSessionEvent(
      fakeEvent("assistant.message_delta", { deltaContent: "a" }),
      acc,
      callbacks,
    );
    await handleSessionEvent(
      fakeEvent("assistant.message_delta", { deltaContent: "b" }),
      acc,
      callbacks,
    );

    expect(startCount).toBe(1);
  });

  it("resets awaitingFirstDelta on assistant.turn_start", async () => {
    const acc = createRunAccumulator({ sessionId: "s1", model: "gpt-5.4", provider: "copilot" });
    acc.awaitingFirstDelta = false;
    const callbacks: RunCallbacks = {};

    await handleSessionEvent(fakeEvent("assistant.turn_start"), acc, callbacks);
    expect(acc.awaitingFirstDelta).toBe(true);
  });

  it("accumulates reasoning deltas", async () => {
    const acc = createRunAccumulator({ sessionId: "s1", model: "gpt-5.4", provider: "copilot" });
    const callbacks: RunCallbacks = {
      onReasoningStream: () => {},
    };

    await handleSessionEvent(
      fakeEvent("assistant.reasoning_delta", { deltaContent: "thinking..." }),
      acc,
      callbacks,
    );
    expect(acc.hasReasoning).toBe(true);
    expect(acc.reasoningText).toBe("thinking...");
  });

  it("tracks tool call count", async () => {
    const acc = createRunAccumulator({ sessionId: "s1", model: "gpt-5.4", provider: "copilot" });
    const callbacks: RunCallbacks = {};

    await handleSessionEvent(
      fakeEvent("tool.execution_complete", { toolName: "bash" }),
      acc,
      callbacks,
    );
    await handleSessionEvent(
      fakeEvent("tool.execution_complete", { toolName: "read" }),
      acc,
      callbacks,
    );
    expect(acc.toolCallCount).toBe(2);
  });

  it("captures session errors", async () => {
    const acc = createRunAccumulator({ sessionId: "s1", model: "gpt-5.4", provider: "copilot" });
    const callbacks: RunCallbacks = {};

    await handleSessionEvent(
      fakeEvent("session.error", { message: "auth failed" }),
      acc,
      callbacks,
    );
    expect(acc.error).toEqual({ kind: "session_error", message: "auth failed" });
  });

  it("captures usage from assistant.usage", async () => {
    const acc = createRunAccumulator({ sessionId: "s1", model: "gpt-5.4", provider: "copilot" });
    const callbacks: RunCallbacks = {};

    await handleSessionEvent(
      fakeEvent("assistant.usage", { inputTokens: 100, outputTokens: 50, totalTokens: 150 }),
      acc,
      callbacks,
    );
    expect(acc.usage).toEqual({ input: 100, output: 50, total: 150 });
  });
});

describe("buildRunResult", () => {
  it("builds result with text payload", () => {
    const acc = createRunAccumulator({ sessionId: "s1", model: "gpt-5.4", provider: "copilot" });
    acc.text = "Hello world";
    acc.hasContent = true;
    acc.usage = { input: 100, output: 50, total: 150 };

    const result = buildRunResult(acc, 1234);

    expect(result.payloads).toHaveLength(1);
    expect(result.payloads![0].text).toBe("Hello world");
    expect(result.meta.durationMs).toBe(1234);
    expect(result.meta.agentMeta?.model).toBe("gpt-5.4");
    expect(result.meta.agentMeta?.provider).toBe("copilot");
    expect(result.meta.agentMeta?.usage).toEqual({ input: 100, output: 50, total: 150 });
  });

  it("includes reasoning payload when present", () => {
    const acc = createRunAccumulator({ sessionId: "s1", model: "gpt-5.4", provider: "copilot" });
    acc.text = "Answer";
    acc.hasContent = true;
    acc.hasReasoning = true;
    acc.reasoningText = "Thinking about it...";

    const result = buildRunResult(acc, 500);

    expect(result.payloads).toHaveLength(2);
    expect(result.payloads![0].isReasoning).toBe(true);
    expect(result.payloads![0].text).toBe("Thinking about it...");
    expect(result.payloads![1].text).toBe("Answer");
  });

  it("returns undefined payloads when no content", () => {
    const acc = createRunAccumulator({ sessionId: "s1", model: "gpt-5.4", provider: "copilot" });
    const result = buildRunResult(acc, 100);
    expect(result.payloads).toBeUndefined();
  });
});
