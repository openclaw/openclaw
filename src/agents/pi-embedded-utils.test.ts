import type { AssistantMessage } from "@mariozechner/pi-ai";
import { describe, expect, it } from "vitest";
import {
  extractAssistantText,
  formatReasoningMessage,
  parseQwenEmbeddedToolCalls,
  promoteThinkingTagsToBlocks,
  stripDowngradedToolCallText,
  stripToolCallXml,
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

  it("preserves response when errorMessage set from background failure (#13935)", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: "Here is the result.",
        },
      ],
      stopReason: "stop",
      errorMessage: "Background tool execution failed",
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).toBe("Here is the result.");
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

describe("promoteThinkingTagsToBlocks", () => {
  it("does not crash on malformed null content entries", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [null as never, { type: "text", text: "<thinking>hello</thinking>ok" }],
      timestamp: Date.now(),
    });
    expect(() => promoteThinkingTagsToBlocks(msg)).not.toThrow();
    const types = msg.content.map((b: { type?: string }) => b?.type);
    expect(types).toContain("thinking");
    expect(types).toContain("text");
  });

  it("does not crash on undefined content entries", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [undefined as never, { type: "text", text: "no tags here" }],
      timestamp: Date.now(),
    });
    expect(() => promoteThinkingTagsToBlocks(msg)).not.toThrow();
  });

  it("passes through well-formed content unchanged when no thinking tags", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [{ type: "text", text: "hello world" }],
      timestamp: Date.now(),
    });
    promoteThinkingTagsToBlocks(msg);
    expect(msg.content).toEqual([{ type: "text", text: "hello world" }]);
  });
});

describe("stripToolCallXml", () => {
  it("strips <tool_call> blocks", () => {
    const text = `Before<tool_call>
{"name": "search", "arguments": {"query": "test"}}
</tool_call>After`;
    expect(stripToolCallXml(text)).toBe("BeforeAfter");
  });

  it("strips <tool_result> blocks", () => {
    const text = `Before<tool_result>
Spawned sub-agent coding (id: sa_01jt3cwwqb5rz7hqp6ghh5qc12)
</tool_result>After`;
    expect(stripToolCallXml(text)).toBe("BeforeAfter");
  });

  it("strips both tool_call and tool_result blocks", () => {
    const text = `I'll help with that.
<tool_call>
{"name": "subagents", "arguments": {"action": "spawn"}}
</tool_call>
<tool_result>
Spawned sub-agent coding
</tool_result>
Here is the result.`;
    expect(stripToolCallXml(text)).toBe("I'll help with that.\n\n\nHere is the result.");
  });

  it("handles tags with attributes", () => {
    const text = `Start<tool_call id="123" type="function">content</tool_call>End`;
    expect(stripToolCallXml(text)).toBe("StartEnd");
  });

  it("handles stray unclosed tags", () => {
    const text = "Some text<tool_call>more text";
    expect(stripToolCallXml(text)).toBe("Some textmore text");
  });

  it("returns text unchanged when no tool tags present", () => {
    const text = "Normal response without any tool markup.";
    expect(stripToolCallXml(text)).toBe(text);
  });

  it("returns empty/falsy input unchanged", () => {
    expect(stripToolCallXml("")).toBe("");
  });
});

describe("extractAssistantText strips tool_call XML (#40879)", () => {
  it("strips tool_call XML from assistant messages", () => {
    const msg = makeAssistantMessage({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `I'll search for that.
<tool_call>
{"name": "search", "arguments": {"query": "test"}}
</tool_call>
<tool_result>
Found 3 results.
</tool_result>
Here are the results.`,
        },
      ],
      timestamp: Date.now(),
    });

    const result = extractAssistantText(msg);
    expect(result).not.toContain("<tool_call>");
    expect(result).not.toContain("<tool_result>");
    expect(result).toContain("I'll search for that.");
    expect(result).toContain("Here are the results.");
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

describe("parseQwenEmbeddedToolCalls", () => {
  it("parses single-param Qwen tool call (read)", () => {
    const text = `看起来有一个语法错误。让我查看一下文件内容。\n\n<tool_call>\n<function=read>\n<parameter=path>\n/Users/zhao/.openclaw/workspace/mysql_connect.py\n</parameter>\n</function>\n</tool_call>`;
    const result = parseQwenEmbeddedToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("read");
    expect(result.toolCalls[0].arguments.path).toBe("/Users/zhao/.openclaw/workspace/mysql_connect.py");
    expect(result.remainingText).not.toContain("<tool_call>");
  });

  it("parses multi-param Qwen tool call (exec)", () => {
    const text = `我已修复了代码，现在重新执行脚本：\n\n<tool_call>\n<function=exec>\n<parameter=command>\ncd /workspace && python test.py\n</parameter>\n<parameter=pty>\ntrue\n</parameter>\n<parameter=timeout>\n30\n</parameter>\n</function>\n</tool_call>`;
    const result = parseQwenEmbeddedToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("exec");
    expect(result.toolCalls[0].arguments.command).toBe("cd /workspace && python test.py");
    expect(result.toolCalls[0].arguments.pty).toBe(true);
    expect(result.toolCalls[0].arguments.timeout).toBe(30);
  });

  it("parses write tool call with multiline content", () => {
    const text = `<tool_call>\n<function=write>\n<parameter=path>\n/test.py\n</parameter>\n<parameter=content>\nprint("hello")\nprint("world")\n</parameter>\n</function>\n</tool_call>`;
    const result = parseQwenEmbeddedToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].name).toBe("write");
    expect(result.toolCalls[0].arguments.path).toBe("/test.py");
    expect(result.toolCalls[0].arguments.content).toContain('print("hello")');
  });

  it("returns unchanged text when no tool_call present", () => {
    const text = "Normal response without any tool calls.";
    const result = parseQwenEmbeddedToolCalls(text);
    expect(result.toolCalls).toHaveLength(0);
    expect(result.remainingText).toBe(text);
  });

  it("handles empty input", () => {
    const result = parseQwenEmbeddedToolCalls("");
    expect(result.toolCalls).toHaveLength(0);
    expect(result.remainingText).toBe("");
  });

  it("preserves remaining text outside tool_call blocks", () => {
    const text = "Before text.\n\n<tool_call>\n<function=read>\n<parameter=path>\n/test.py\n</parameter>\n</function>\n</tool_call>\n\nAfter text.";
    const result = parseQwenEmbeddedToolCalls(text);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.remainingText).toContain("Before text.");
    expect(result.remainingText).toContain("After text.");
    expect(result.remainingText).not.toContain("<tool_call>");
  });
});
