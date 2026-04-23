import type { AgentMessage } from "@mariozechner/pi-agent-core";
import { describe, expect, it } from "vitest";
import { projectContextEngineAssemblyForCodex } from "./context-engine-projection.js";

function textMessage(role: AgentMessage["role"], text: string): AgentMessage {
  return {
    role,
    content: [{ type: "text", text }],
    timestamp: 1,
  } as AgentMessage;
}

describe("projectContextEngineAssemblyForCodex", () => {
  it("produces stable output for identical inputs", () => {
    const params = {
      assembledMessages: [
        textMessage("user", "Earlier question"),
        textMessage("assistant", "Earlier answer"),
      ],
      originalHistoryMessages: [textMessage("user", "Earlier question")],
      prompt: "Need the latest answer",
      systemPromptAddition: "memory recall",
    };

    expect(projectContextEngineAssemblyForCodex(params)).toEqual(
      projectContextEngineAssemblyForCodex(params),
    );
  });

  it("drops a duplicate trailing current prompt from assembled history", () => {
    const result = projectContextEngineAssemblyForCodex({
      assembledMessages: [
        textMessage("assistant", "You already asked this."),
        textMessage("user", "Need the latest answer"),
      ],
      originalHistoryMessages: [textMessage("assistant", "You already asked this.")],
      prompt: "Need the latest answer",
      systemPromptAddition: "memory recall",
    });

    expect(result.promptText).not.toContain("[user]\nNeed the latest answer");
    expect(result.promptText).toContain("Current user request:\nNeed the latest answer");
    expect(result.developerInstructionAddition).toBe("memory recall");
  });

  it("preserves role order and falls back to the raw prompt for empty history", () => {
    const empty = projectContextEngineAssemblyForCodex({
      assembledMessages: [],
      originalHistoryMessages: [],
      prompt: "hello",
    });
    expect(empty.promptText).toBe("hello");

    const ordered = projectContextEngineAssemblyForCodex({
      assembledMessages: [
        textMessage("user", "one"),
        textMessage("assistant", "two"),
        textMessage("toolResult", "three"),
      ],
      originalHistoryMessages: [textMessage("user", "seed")],
      prompt: "next",
    });
    expect(ordered.promptText).toContain("[user]\none\n\n[assistant]\ntwo\n\n[toolResult]\nthree");
    expect(ordered.prePromptMessageCount).toBe(1);
  });
});
