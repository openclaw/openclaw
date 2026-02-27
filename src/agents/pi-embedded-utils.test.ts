import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  extractAssistantText,
  formatReasoningMessage,
  stripDowngradedToolCallText,
  stripToolXmlBlocks,
} from "./pi-embedded-utils.js";

function makeAssistantMessage(
  message: Omit<AssistantMessage, "api" | "provider" | "model" | "usage" | "stopReason"> &
    Partial<Pick<AssistantMessage, "api" | "provider" | "model" | "usage" | "stopReason">>,
): AssistantMessage {
  return {
    api: "responses",
    provider: "openai",
    model: "gpt-5",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    ...message,
  };
}

describe("extractAssistantText", () => {
  it("strips tool-only Minimax invocation XML from text", () => {
    const cases = [
      `<invoke name="Bash">
<parameter name="command">netstat -tlnp | grep 18789</parameter>
</invoke>
</minimax:tool_call>`,
      `<invoke name="Bash">
<parameter name="command">test</parameter>
</invoke>
</minimax:tool_call>`,
    ];
    for (const text of cases) {
      const msg = makeAssistantMessage({
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      });
      expect(extractAssistantText(msg)).toBe("");
    }
  });

  it("strips multiple tool invocations", () => {
    const msg = makeAssistantMessage({
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
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Let me check that.");
  });

  it("keeps invoke snippets without Minimax markers", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Example:\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe(
      `Example:\n<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>`,
    );
  });

  it("preserves normal text without tool invocations", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "This is a normal response without any tool calls.",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("This is a normal response without any tool calls.");
  });

  it("sanitizes HTTP-ish error text only when stopReason is error", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      stopReason: "error",
      errorMessage: "500 Internal Server Error",
      content: [{ type: "text", text: "500 Internal Server Error" }],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("HTTP 500: Internal Server Error");
  });

  it("does not rewrite normal text that references billing plans", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Firebase downgraded Chore Champ to the Spark plan; confirm whether billing should be re-enabled.",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe(
      "Firebase downgraded Chore Champ to the Spark plan; confirm whether billing should be re-enabled.",
    );
  });

  it("strips Minimax tool invocations with extra attributes", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Before<invoke name='Bash' data-foo="bar">\n<parameter name="command">ls</parameter>\n</invoke>\n</minimax:tool_call>After`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Before\nAfter");
  });

  it("strips minimax tool_call open and close tags", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Start<minimax:tool_call>Inner</minimax:tool_call>End",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("StartInnerEnd");
  });

  it("ignores invoke blocks without minimax markers", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Before<invoke>Keep</invoke>After",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Before<invoke>Keep</invoke>After");
  });

  it("strips invoke blocks when minimax markers are present elsewhere", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Before<invoke>Drop</invoke><minimax:tool_call>After",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("BeforeAfter");
  });

  it("strips invoke blocks with nested tags", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `A<invoke name="Bash"><param><deep>1</deep></param></invoke></minimax:tool_call>B`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("AB");
  });

  it("strips tool XML mixed with regular content", () => {
    const msg = makeAssistantMessage({
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
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("I'll help you with that.\nHere are the results.");
  });

  it("handles multiple invoke blocks in one message", () => {
    const msg = makeAssistantMessage({
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
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("First check.\nSecond check.\nDone.");
  });

  it("handles stray closing tags without opening tags", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Some text here.</minimax:tool_call>More text.",
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Some text here.More text.");
  });

  it("handles multiple text blocks", () => {
    const msg = makeAssistantMessage({
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
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("First block.\nThird block.");
  });

  it("strips downgraded Gemini tool call text representations", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[Tool Call: exec (ID: toolu_vrtx_014w1P6B6w4V92v4VzG7Qk12)]
Arguments: { "command": "git status", "timeout": 120000 }`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips multiple downgraded tool calls", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[Tool Call: read (ID: toolu_1)]
Arguments: { "path": "/some/file.txt" }
[Tool Call: exec (ID: toolu_2)]
Arguments: { "command": "ls -la" }`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("strips tool results for downgraded calls", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[Tool Result for ID toolu_123]
{"status": "ok", "data": "some result"}`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("");
  });

  it("preserves text around downgraded tool calls", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Let me check that for you.
[Tool Call: browser (ID: toolu_abc)]
Arguments: { "action": "act", "request": "click button" }`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Let me check that for you.");
  });

  it("preserves trailing text after downgraded tool call blocks", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `Intro text.
[Tool Call: read (ID: toolu_1)]
Arguments: {
  "path": "/tmp/file.txt"
}
Back to the user.`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Intro text.\nBack to the user.");
  });

  it("handles multiple text blocks with tool calls and results", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
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
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Here's what I found:\nDone checking.");
  });

  it("strips reasoning/thinking tag variants", () => {
    const cases = [
      {
        name: "think tag",
        text: "<think>El usuario quiere retomar una tarea...</think>Aquí está tu respuesta.",
        expected: "Aquí está tu respuesta.",
      },
      {
        name: "think tag with attributes",
        text: `<think reason="deliberate">Hidden</think>Visible`,
        expected: "Visible",
      },
      {
        name: "unclosed think tag",
        text: "<think>Pensando sobre el problema...",
        expected: "",
      },
      {
        name: "thinking tag",
        text: "Before<thinking>internal reasoning</thinking>After",
        expected: "BeforeAfter",
      },
      {
        name: "antthinking tag",
        text: "<antthinking>Some reasoning</antthinking>The actual answer.",
        expected: "The actual answer.",
      },
      {
        name: "final wrapper",
        text: "<final>\nAnswer\n</final>",
        expected: "Answer",
      },
      {
        name: "thought tag",
        text: "<thought>Internal deliberation</thought>Final response.",
        expected: "Final response.",
      },
      {
        name: "multiple think blocks",
        text: "Start<think>first thought</think>Middle<think>second thought</think>End",
        expected: "StartMiddleEnd",
      },
    ] as const;

    for (const testCase of cases) {
      const msg = makeAssistantMessage({
        role: "assistant",
        content: [{ type: "text", text: testCase.text }],
        timestamp: Date.now(),
      });
      expect(extractAssistantText(msg), testCase.name).toBe(testCase.expected);
    }
  });
});

describe("formatReasoningMessage", () => {
  it("returns empty string for whitespace-only input", () => {
    expect(formatReasoningMessage("   \n  \t  ")).toBe("");
  });

  it("wraps single line in italics", () => {
    expect(formatReasoningMessage("Single line of reasoning")).toBe(
      "Reasoning:\n_Single line of reasoning_",
    );
  });

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

describe("stripDowngradedToolCallText", () => {
  it("strips downgraded marker blocks while preserving surrounding user-facing text", () => {
    const cases = [
      {
        name: "historical context only",
        text: `[Historical context: a different model called tool "exec" with arguments {"command":"git status"}]`,
        expected: "",
      },
      {
        name: "text before historical context",
        text: `Here is the answer.\n[Historical context: a different model called tool "read"]`,
        expected: "Here is the answer.",
      },
      {
        name: "text around historical context",
        text: `Before.\n[Historical context: tool call info]\nAfter.`,
        expected: "Before.\nAfter.",
      },
      {
        name: "multiple historical context blocks",
        text: `[Historical context: first tool call]\n[Historical context: second tool call]`,
        expected: "",
      },
      {
        name: "mixed tool call and historical context",
        text: `Intro.\n[Tool Call: exec (ID: toolu_1)]\nArguments: { "command": "ls" }\n[Historical context: a different model called tool "read"]`,
        expected: "Intro.",
      },
      {
        name: "no markers",
        text: "Just a normal response with no markers.",
        expected: "Just a normal response with no markers.",
      },
    ] as const;

    for (const testCase of cases) {
      expect(stripDowngradedToolCallText(testCase.text), testCase.name).toBe(testCase.expected);
    }
  });
});

describe("stripToolXmlBlocks", () => {
  it("strips tool_call spanning two chunks", () => {
    const state = { toolXmlDepth: 0 };
    // Chunk 1: open tag without close — content should be dropped.
    const chunk1 = stripToolXmlBlocks('Hello <tool_call>{"name": "bash", ', state);
    expect(chunk1).toBe("Hello ");
    expect(state.toolXmlDepth).toBe(1);

    // Chunk 2: close tag — trailing text after close should appear.
    const chunk2 = stripToolXmlBlocks('"args": {"cmd": "ls"}}</tool_call> Done.', state);
    expect(chunk2).toBe(" Done.");
    expect(state.toolXmlDepth).toBe(0);
  });

  it("strips nested antml_function_calls/antml_invoke across chunks", () => {
    const state = { toolXmlDepth: 0 };
    // Chunk 1: outer open + inner open (depth goes to 2).
    const chunk1 = stripToolXmlBlocks(
      "Before <antml_function_calls><antml_invoke name='test'>",
      state,
    );
    expect(chunk1).toBe("Before ");
    expect(state.toolXmlDepth).toBe(2);

    // Chunk 2: inner content — still inside, everything dropped.
    const chunk2 = stripToolXmlBlocks("param value", state);
    expect(chunk2).toBe("");
    expect(state.toolXmlDepth).toBe(2);

    // Chunk 3: close inner + close outer.
    const chunk3 = stripToolXmlBlocks("</antml_invoke></antml_function_calls> After", state);
    expect(chunk3).toBe(" After");
    expect(state.toolXmlDepth).toBe(0);
  });

  it("preserves tool XML inside code spans", () => {
    const state = { toolXmlDepth: 0 };
    const text = "Use `<tool_call>` to invoke tools.";
    // Simulate a code span covering positions 4..17 (the backtick-delimited range).
    const codeStart = text.indexOf("<tool_call>");
    const result = stripToolXmlBlocks(text, state, (idx) => idx === codeStart);
    expect(result).toBe(text);
    expect(state.toolXmlDepth).toBe(0);
  });

  it("depth counter resets after all close tags — subsequent text not suppressed", () => {
    const state = { toolXmlDepth: 0 };
    // Open + close in same chunk; then new text arrives in next chunk.
    const chunk1 = stripToolXmlBlocks("A <tool_call>hidden</tool_call> B", state);
    expect(chunk1).toBe("A  B");
    expect(state.toolXmlDepth).toBe(0);

    // Next chunk: plain text, no suppression.
    const chunk2 = stripToolXmlBlocks("More text here.", state);
    expect(chunk2).toBe("More text here.");
    expect(state.toolXmlDepth).toBe(0);
  });

  it("handles close tag without matching open (depth stays at 0)", () => {
    const state = { toolXmlDepth: 0 };
    const result = stripToolXmlBlocks("text </tool_result> more", state);
    expect(result).toBe("text  more");
    expect(state.toolXmlDepth).toBe(0);
  });

  it("fast-path returns text unchanged when no markers and depth is 0", () => {
    const state = { toolXmlDepth: 0 };
    const text = "This is plain text with no XML markers.";
    const result = stripToolXmlBlocks(text, state);
    expect(result).toBe(text);
    expect(state.toolXmlDepth).toBe(0);
  });

  it("strips tool_result blocks", () => {
    const state = { toolXmlDepth: 0 };
    const result = stripToolXmlBlocks("Before <tool_result>some output</tool_result> After", state);
    expect(result).toBe("Before  After");
    expect(state.toolXmlDepth).toBe(0);
  });

  it("strips antml tags case-insensitively", () => {
    const state = { toolXmlDepth: 0 };
    const result = stripToolXmlBlocks(
      "A <ANTML_FUNCTION_CALLS><ANTML_INVOKE>x</ANTML_INVOKE></ANTML_FUNCTION_CALLS> B",
      state,
    );
    expect(result).toBe("A  B");
    expect(state.toolXmlDepth).toBe(0);
  });
});

describe("empty input handling", () => {
  it("returns empty string", () => {
    const helpers = [formatReasoningMessage, stripDowngradedToolCallText];
    for (const helper of helpers) {
      expect(helper("")).toBe("");
    }
  });
});
