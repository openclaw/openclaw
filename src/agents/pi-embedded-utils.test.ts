import { describe, expect, it } from "vitest";
import {
  extractAssistantText,
  formatReasoningMessage,
  stripHistoricalContext,
} from "./pi-embedded-utils.js";

function mockMsg(content: any): any {
  return {
    role: "assistant",
    content,
    timestamp: Date.now(),
    api: "test-api",
    provider: "test-provider",
    model: "test-model",
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: "stop",
  };
}

describe("extractAssistantText", () => {
  it("strips Minimax tool invocation XML from text", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `<invoke name="Bash">
<parameter name="command">netstat -tlnp | grep 18789</parameter>
</invoke>
</minimax:tool_call>`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips multiple tool invocations", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `Let me check that.<invoke name="Read">
<parameter name="path">/home/admin/test.txt</parameter>
</invoke>
</minimax:tool_call>`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("Let me check that.");
  });

  it("keeps invoke snippets without Minimax markers", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `Example:\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe(
      `Example:\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>`,
    );
  });

  it("preserves normal text without tool invocations", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "This is a normal response without any tool calls.",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("This is a normal response without any tool calls.");
  });

  it("strips Minimax tool invocations with extra attributes", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `Before<invoke name='Bash' data-foo="bar">\n<parameter name="command">ls</parameter>\n</invoke>\n</minimax:tool_call>After`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("Before\nAfter");
  });

  it("strips minimax tool_call open and close tags", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "Start<minimax:tool_call>Inner</minimax:tool_call>End",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("StartInnerEnd");
  });

  it("ignores invoke blocks without minimax markers", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "Before<invoke>Keep</invoke>After",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("Before<invoke>Keep</invoke>After");
  });

  it("strips invoke blocks when minimax markers are present elsewhere", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "Before<invoke>Drop</invoke><minimax:tool_call>After",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("BeforeAfter");
  });

  it("strips invoke blocks with nested tags", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `A<invoke name="Bash"><param><deep>1</deep></param></invoke></minimax:tool_call>B`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("AB");
  });

  it("strips tool XML mixed with regular content", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `I'll help you with that.<invoke name="Bash">
<parameter name="command">ls -la</parameter>
</invoke>
</minimax:tool_call>Here are the results.`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("I'll help you with that.\nHere are the results.");
  });

  it("handles multiple invoke blocks in one message", () => {
    const msg = mockMsg([
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
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("First check.\nSecond check.\nDone.");
  });

  it("handles stray closing tags without opening tags", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "Some text here.</minimax:tool_call>More text.",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("Some text here.More text.");
  });

  it("returns empty string when message is only tool invocations", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `<invoke name="Bash">
<parameter name="command">test</parameter>
</invoke>
</minimax:tool_call>`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("handles multiple text blocks", () => {
    const msg = mockMsg([
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
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("First block.\nThird block.");
  });

  it("strips downgraded Gemini tool call text representations", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `[Tool Call: exec (ID: toolu_vrtx_014w1P6B6w4V92v4VzG7Qk12)]
Arguments: { "command": "git status", "timeout": 120000 }`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips multiple downgraded tool calls", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `[Tool Call: read (ID: toolu_1)]
Arguments: { "path": "/some/file.txt" }
[Tool Call: exec (ID: toolu_2)]
Arguments: { "command": "ls -la" }`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips tool results for downgraded calls", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `[Tool Result for ID toolu_123]
{"status": "ok", "data": "some result"}`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("preserves text around downgraded tool calls", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `Let me check that for you.
[Tool Call: browser (ID: toolu_abc)]
Arguments: { "action": "act", "request": "click button" }`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("Let me check that for you.");
  });

  it("preserves trailing text after downgraded tool call blocks", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `Intro text.
[Tool Call: read (ID: toolu_1)]
Arguments: {
  "path": "/tmp/file.txt"
}
Back to the user.`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("Intro text.\nBack to the user.");
  });

  it("handles multiple text blocks with tool calls and results", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "Here's what I found:",
      },
      {
        type: "text",
        text: `[Tool Call: read (ID: toolu_1)]
Arguments: { "path": "/test.txt" }`,
      },
      {
        type: "text",
        text: `[Tool Result for ID toolu_1]
File contents here`,
      },
      {
        type: "text",
        text: "Done checking.",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("Here's what I found:\nDone checking.");
  });

  it("strips thinking tags from text content", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "<think>El usuario quiere retomar una tarea...</think>Aquí está tu respuesta.",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("Aquí está tu respuesta.");
  });

  it("strips thinking tags with attributes", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: `<think reason="deliberate">Hidden</think>Visible`,
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("Visible");
  });

  it("strips thinking tags without closing tag", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "<think>Pensando sobre el problema...",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips thinking tags with various formats", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "Before<thinking>internal reasoning</thinking>After",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("BeforeAfter");
  });

  it("strips antthinking tags", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "<antthinking>Some reasoning</antthinking>The actual answer.",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("The actual answer.");
  });

  it("strips final tags while keeping content", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "<final>\nAnswer\n</final>",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("Answer");
  });

  it("strips thought tags", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "<thought>Internal deliberation</thought>Final response.",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("Final response.");
  });

  it("handles nested or multiple thinking blocks", () => {
    const msg = mockMsg([
      {
        type: "text",
        text: "Start<think>first thought</think>Middle<think>second thought</think>End",
      },
    ]);

    const result = extractAssistantText(msg);
    expect(result).toBe("StartMiddleEnd");
  });
});

describe("formatReasoningMessage", () => {
  it("returns empty string for empty input", () => {
    expect(formatReasoningMessage("")).toBe("");
  });

  it("returns empty string for whitespace-only input", () => {
    expect(formatReasoningMessage("   \n  \t  ")).toBe("");
  });

  it("wraps single line in italics", () => {
    expect(formatReasoningMessage("Single line of reasoning")).toBe(
      "Reasoning:\n_Single line of reasoning_",
    );
  });
});

describe("stripHistoricalContext", () => {
  it("removes simple historical context", () => {
    const input = "[Historical context: User said hello]\nActual response";
    expect(stripHistoricalContext(input)).toBe("Actual response");
  });

  it("removes historical context with nested brackets", () => {
    const input = "[Historical context: User said [bracket] stuff]\nActual response";
    expect(stripHistoricalContext(input)).toBe("Actual response");
  });

  it("removes historical context with multiple levels of nesting", () => {
    const input = "[Historical context: Level 1 [Level 2 [Level 3]] end]\nClean";
    expect(stripHistoricalContext(input)).toBe("Clean");
  });

  it("removes multiple historical context blocks", () => {
    const input = "[Historical context: A]\nMiddle\n[Historical context: B]\nEnd";
    expect(stripHistoricalContext(input)).toBe("Middle\nEnd");
  });

  it("handles malformed input gracefully (no closing bracket)", () => {
    const input = "[Historical context: Never ending";
    // Should verify it doesn't crash or hang.
    // Current impl breaks loop, returning input as is or partial?
    // Let's assume it returns input if not found.
    expect(stripHistoricalContext(input)).toBe(input);
  });

  it("removes deeply nested historical context (SENA context leak repro)", () => {
    const input = `[Historical context: User said [something [nested]] here]
Oppa! G-Drive Cleanup is ready!`;
    const expected = "Oppa! G-Drive Cleanup is ready!";
    expect(stripHistoricalContext(input).trim()).toBe(expected);
  });
});

describe("formatReasoningMessage (continued)", () => {
  it("wraps each line separately for multiline text (Telegram fix)", () => {
    expect(formatReasoningMessage("Line one\nLine two\nLine three")).toBe(
      "Reasoning:\n_Line one_\n_Line two_\n_Line three_",
    );
  });

  it("preserves empty lines between reasoning text", () => {
    expect(formatReasoningMessage("First block\n\nSecond block")).toBe(
      "Reasoning:\n_First block_\n\n_Second block_",
    );
  });

  it("handles mixed empty and non-empty lines", () => {
    expect(formatReasoningMessage("A\n\nB\nC")).toBe("Reasoning:\n_A_\n\n_B_\n_C_");
  });

  it("trims leading/trailing whitespace", () => {
    expect(formatReasoningMessage("  \n  Reasoning here  \n  ")).toBe(
      "Reasoning:\n_Reasoning here_",
    );
  });
});
