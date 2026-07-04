import { describe, expect, it } from "vitest";
import { buildMessagesSnapshot } from "./run-attempt.js";

describe("buildMessagesSnapshot", () => {
  it("stamps assistant messages with the actual provider/model, not a hardcoded anthropic default", () => {
    const acc = {
      assistantTexts: ["hi there"],
      toolMetas: [],
      reasoning: "",
      itemCount: 1,
      toolCalls: new Map(),
      usage: { input: 10, output: 5, total: 15 },
    };
    const messages = buildMessagesSnapshot(acc, { provider: "zai", model: "glm-5.2" });
    expect(messages).toHaveLength(1);
    const assistant = messages[0] as unknown as { provider: string; model: string };
    expect(assistant.provider).toBe("zai");
    expect(assistant.model).toBe("glm-5.2");
  });

  it("stamps tool-call/tool-result assistant messages with the actual provider/model", () => {
    const acc = {
      assistantTexts: [],
      toolMetas: [],
      reasoning: "",
      itemCount: 1,
      toolCalls: new Map([
        ["item-1", { name: "Read", args: { path: "/tmp/x" }, result: "contents", isError: false }],
      ]),
      usage: { input: 0, output: 0, total: 0 },
    };
    const messages = buildMessagesSnapshot(acc, {
      provider: "anthropic",
      model: "claude-sonnet-5",
    });
    expect(messages).toHaveLength(2);
    const toolCallAssistant = messages[0] as unknown as { provider: string; model: string };
    expect(toolCallAssistant.provider).toBe("anthropic");
    expect(toolCallAssistant.model).toBe("claude-sonnet-5");
  });
});
