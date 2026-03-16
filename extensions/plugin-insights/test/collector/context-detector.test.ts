import { describe, it, expect } from "vitest";
import { ContextDetector } from "../../src/collector/context-detector.js";
import type { AgentMessage, UserMessage, AssistantMessage } from "../../src/types.js";

function mkUserMessage(content: string): UserMessage {
  return { role: "user", content, timestamp: Date.now() };
}

function mkAssistantMessage(text: string): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    usage: { input: 50, output: 30, cacheRead: 0, cacheWrite: 0, total: 80 },
    model: "test",
    api: "test",
    provider: "test",
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

describe("ContextDetector", () => {
  it("should detect known plugin markers in user messages", () => {
    const detector = new ContextDetector();

    const messages: AgentMessage[] = [
      mkUserMessage("[memory-plugin] Here is your relevant memory..."),
      mkUserMessage("What did I work on yesterday?"),
    ];

    const results = detector.detect(messages);
    expect(results).toHaveLength(1);
    expect(results[0].pluginId).toBe("memory-plugin");
    expect(results[0].action).toBe("context_injection");
  });

  it("should detect multiple plugins in different messages", () => {
    const detector = new ContextDetector();

    const messages: AgentMessage[] = [
      mkUserMessage("[memory-core] Recalled facts..."),
      mkUserMessage("[lcm] Lossless context data..."),
      mkUserMessage("Hello"),
    ];

    const results = detector.detect(messages);
    expect(results).toHaveLength(2);
    const ids = results.map((r) => r.pluginId);
    expect(ids).toContain("memory-core");
    expect(ids).toContain("lossless-claw");
  });

  it("should not duplicate same plugin from multiple messages", () => {
    const detector = new ContextDetector();

    const messages: AgentMessage[] = [
      mkUserMessage("[memory-core] data 1"),
      mkUserMessage("[memory-core] data 2"),
    ];

    const results = detector.detect(messages);
    expect(results).toHaveLength(1);
  });

  it("should also detect markers in assistant messages via extractAllText", () => {
    const detector = new ContextDetector();

    // The new ContextDetector uses extractAllText which reads both user and assistant text
    const messages: AgentMessage[] = [mkAssistantMessage("[memory-core] I found some data")];

    const results = detector.detect(messages);
    expect(results).toHaveLength(1);
    expect(results[0].pluginId).toBe("memory-core");
  });

  it("should support custom markers", () => {
    const detector = new ContextDetector([[/\[my-plugin\]/i, "my-plugin"]]);

    const messages: AgentMessage[] = [mkUserMessage("[my-plugin] custom data")];

    const results = detector.detect(messages);
    expect(results).toHaveLength(1);
    expect(results[0].pluginId).toBe("my-plugin");
  });
});
