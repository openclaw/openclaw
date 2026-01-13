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

  it("keeps invoke snippets without Minimax markers", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Example:\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe(
      `Example:\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>`,
    );
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

  it("strips Minimax tool invocations with extra attributes", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Before<invoke name='Bash' data-foo="bar">\n<parameter name="command">ls</parameter>\n</invoke>\n</minimax:tool_call>After`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Before\nAfter");
  });

  it("strips minimax tool_call open and close tags", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Start<minimax:tool_call>Inner</minimax:tool_call>End",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("StartInnerEnd");
  });

  it("ignores invoke blocks without minimax markers", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Before<invoke>Keep</invoke>After",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("Before<invoke>Keep</invoke>After");
  });

  it("strips invoke blocks when minimax markers are present elsewhere", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Before<invoke>Drop</invoke><minimax:tool_call>After",
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("BeforeAfter");
  });

  it("strips invoke blocks with nested tags", () => {
    const msg: AssistantMessage = {
      role: "assistant",
      content: [
        {
          type: "text",
          text: `A<invoke name="Bash"><param><deep>1</deep></param></invoke></minimax:tool_call>B`,
        },
      ],
      timestamp: Date.now(),
    };

    const result = extractAssistantText(msg);
    expect(result).toBe("AB");
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
