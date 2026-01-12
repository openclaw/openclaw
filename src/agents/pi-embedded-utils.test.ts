import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import { extractAssistantText } from "./pi-embedded-utils.js";

describe("extractAssistantText", () => {
  it("strips Minimax tool invocation XML from text", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<invoke name="Bash">
<parameter name="command">netstat -tlnp | grep 18789</parameter>
</invoke>
</minimax:tool_call>`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips multiple tool invocations", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Let me check that.<invoke name="Read">
<parameter name="path">/home/admin/test.txt</parameter>
</invoke>
</minimax:tool_call>`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Let me check that.");
  });

  it("preserves normal text without tool invocations", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "This is a normal response without any tool calls.",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("This is a normal response without any tool calls.");
  });

  it("strips tool XML mixed with regular content", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `I'll help you with that.<invoke name="Bash">
<parameter name="command">ls -la</parameter>
</invoke>
</minimax:tool_call>Here are the results.`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("I'll help you with that.\nHere are the results.");
  });

  it("handles multiple invoke blocks in one message", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `First check.<invoke name="Read">
<parameter name="path">file1.txt</parameter>
</invoke>
</minimax:tool_call>Second check.<invoke name="Bash">
<parameter name="command">pwd</parameter>
</invoke>
</minimax:tool_call>Done.`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("First check.\nSecond check.\nDone.");
  });

  it("handles stray closing tags without opening tags", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Some text here.</minimax:tool_call>More text.",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Some text here.More text.");
  });

  it("returns empty string when message is only tool invocations", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `<invoke name="Bash">
<parameter name="command">test</parameter>
</invoke>
</minimax:tool_call>`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("handles multiple text blocks", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "First block.",
        },
        {
          type: "text",
          text: `<invoke name="Bash">
<parameter name="command">ls</parameter>
</invoke>
</minimax:tool_call>`,
        },
        {
          type: "text",
          text: "Third block.",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("First block.\nThird block.");
  });
});
