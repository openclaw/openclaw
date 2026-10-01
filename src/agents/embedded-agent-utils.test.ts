/**
 * Regression coverage for embedded-agent message text utilities.
 * Verifies visible text extraction, reasoning formatting, and thinking-tag promotion.
 */
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import {
  createAssistantVisibleStreamText,
  extractEmbeddedAssistantText,
  extractAssistantThinking,
  extractAssistantVisibleText,
  prepareAssistantVisibleText,
  createThinkingTagStreamState,
  extractThinkingFromTaggedStream,
  extractThinkingFromTaggedText,
  formatReasoningMessage,
  promoteThinkingTagsToBlocks,
  sanitizeAssistantVisibleStreamText,
  stripDowngradedToolCallText,
} from "./embedded-agent-utils.js";
import { createZeroUsageFixture } from "./test-helpers/usage-fixtures.js";

const REFERENCE_THINKING_TAG_NAME_PATTERN = String.raw`(?:(?:antml:|mm:)?(?:think(?:ing)?|thought)|antthinking)`;
const REFERENCE_THINKING_TAG_OPEN_RE = new RegExp(
  String.raw`<\s*${REFERENCE_THINKING_TAG_NAME_PATTERN}\s*>`,
  "gi",
);
const REFERENCE_THINKING_TAG_CLOSE_RE = new RegExp(
  String.raw`<\s*\/\s*${REFERENCE_THINKING_TAG_NAME_PATTERN}\s*>`,
  "gi",
);

function extractThinkingFromTaggedStreamReference(text: string): string {
  if (!text) {
    return "";
  }
  const closed = extractThinkingFromTaggedText(text);
  if (closed) {
    return closed;
  }
  const openMatches = [...text.matchAll(REFERENCE_THINKING_TAG_OPEN_RE)];
  const lastOpen = openMatches.at(-1);
  if (!lastOpen) {
    return "";
  }
  const lastClose = [...text.matchAll(REFERENCE_THINKING_TAG_CLOSE_RE)].at(-1);
  if (lastClose && (lastClose.index ?? -1) > (lastOpen.index ?? -1)) {
    return closed;
  }
  return text.slice((lastOpen.index ?? 0) + lastOpen[0].length).trim();
}

function randomChunks(text: string, seed: number): string[] {
  const chunks: string[] = [];
  let offset = 0;
  let value = seed;
  while (offset < text.length) {
    value = (value * 1664525 + 1013904223) >>> 0;
    const length = Math.min(1 + (value % 7), text.length - offset);
    chunks.push(text.slice(offset, offset + length));
    offset += length;
  }
  return chunks;
}

function makeAssistantMessage(
  message: Omit<
    AssistantMessage,
    "api" | "provider" | "model" | "usage" | "stopReason" | "content" | "role" | "timestamp"
  > &
    Partial<Pick<AssistantMessage, "api" | "provider" | "model" | "usage" | "stopReason">> & {
      content: unknown;
      phase?: "commentary" | "final_answer";
    },
): AssistantMessage {
  return {
    role: "assistant",
    timestamp: 1,
    api: "responses",
    provider: "openai",
    model: "gpt-5",
    usage: createZeroUsageFixture(),
    stopReason: "stop",
    ...message,
  } as unknown as AssistantMessage;
}

describe("createAssistantVisibleStreamText", () => {
  it("keeps interleaved streams independent when one is replaced", () => {
    const first = createAssistantVisibleStreamText();
    const second = createAssistantVisibleStreamText();

    expect(first.append("\n\nAlpha")).toEqual({ text: "Alpha", delta: "Alpha" });
    expect(second.append("\n\nBravo")).toEqual({ text: "Bravo", delta: "Bravo" });
    expect(first.append("\n\nAlpha")).toEqual({ text: "Alpha", delta: "" });
    expect(second.append(" is here")).toEqual({ text: "Bravo is here", delta: " is here" });
    expect(first.replace("Reset")).toEqual({ text: "Reset", delta: null });
    expect(second.append("\n\nBravo is here")).toEqual({ text: "Bravo is here", delta: "" });
    expect(first.append("!")).toEqual({ text: "Reset!", delta: "!" });
  });
});

describe("extractThinkingFromTaggedStream", () => {
  it("matches full-buffer extraction at every randomized chunk boundary", () => {
    const cases = [
      "plain text with <not-a-thinking-tag> and no reasoning",
      "Before <think>first line\nsecond line</think> after",
      "prefix<thought>one</thought>middle<mm:thinking>two</mm:thinking>suffix",
      "surrounding text <antml:think>unfinished reasoning tail",
      "< \nAnTThinking \t>spaced tag content< / antthinking > visible",
      "<think>closed</think><think>unclosed trailing reasoning",
    ];

    for (const text of cases) {
      for (let seed = 1; seed <= 24; seed += 1) {
        const state = createThinkingTagStreamState();
        let prefix = "";
        for (const chunk of randomChunks(text, seed)) {
          prefix += chunk;
          expect(
            extractThinkingFromTaggedStream(prefix, state, chunk),
            `${text} (seed ${seed})`,
          ).toBe(extractThinkingFromTaggedStreamReference(prefix));
        }
      }
    }
  });

  it("resumes from an authoritative checkpoint before consuming later deltas", () => {
    const state = createThinkingTagStreamState();
    let text = "<think>Checkpoint";
    for (const delta of [" continues", "</think>Visible", "", "<think>second</think>"]) {
      text += delta;
      expect(extractThinkingFromTaggedStream(text, state, delta)).toBe(
        extractThinkingFromTaggedStreamReference(text),
      );
    }
  });
});

describe("extractEmbeddedAssistantText", () => {
  it.each([
    {
      title: "strips Minimax tool invocations with extra attributes",
      text: `Before<invoke name='Bash' data-foo="bar">\n<parameter name="command">ls</parameter>\n</invoke>\n</minimax:tool_call>After`,
      expected: "Before\nAfter",
    },
    {
      title: "strips minimax tool_call open and close tags",
      text: "Start<minimax:tool_call>Inner</minimax:tool_call>End",
      expected: "StartInnerEnd",
    },
    {
      title: "ignores invoke blocks without minimax markers",
      text: "Before<invoke>Keep</invoke>After",
      expected: "Before<invoke>Keep</invoke>After",
    },
    {
      title: "handles multiple invoke blocks in one message",
      text: `First check.<invoke name="Read">
<parameter name="path">file1.txt</parameter>
</invoke>
</minimax:tool_call>Second check.<invoke name="Bash">
<parameter name="command">pwd</parameter>
</invoke>
</minimax:tool_call>Done.`,
      expected: "First check.\nSecond check.\nDone.",
    },
    {
      title: "preserves trailing text after downgraded tool call blocks",
      text: `Intro text.
[Tool Call: read (ID: toolu_1)]
Arguments: {
  "path": "/tmp/file.txt"
}
Back to the user.`,
      expected: "Intro text.\nBack to the user.",
    },
  ])("$title", ({ text, expected }) => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "text",
          text,
        },
      ],
    });

    const result = extractEmbeddedAssistantText(msg);
    expect(result).toBe(expected);
  });

  it("sanitizes HTTP-ish error text only when stopReason is error", () => {
    const msg = makeAssistantMessage({
      stopReason: "error",
      errorMessage: "500 Internal Server Error",
      content: [{ type: "text", text: "500 Internal Server Error" }],
    });

    const result = extractEmbeddedAssistantText(msg);
    expect(result).toBe("HTTP 500: Internal Server Error");
  });

  it("preserves response when errorMessage set from background failure (#13935)", () => {
    const responseText = "Handle payment required errors in your API.";
    const msg = makeAssistantMessage({
      errorMessage: "insufficient credits for embedding model",
      stopReason: "stop",
      content: [{ type: "text", text: responseText }],
    });

    const result = extractEmbeddedAssistantText(msg);
    expect(result).toBe(responseText);
  });

  it("handles multiple text blocks", () => {
    const msg = makeAssistantMessage({
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
    });

    const result = extractEmbeddedAssistantText(msg);
    expect(result).toBe("First block.\nThird block.");
  });

  it("handles multiple text blocks with tool calls and results", () => {
    const msg = makeAssistantMessage({
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
    });

    const result = extractEmbeddedAssistantText(msg);
    expect(result).toBe("Here's what I found:\nDone checking.");
  });

  it("strips mixed <tool_call> and <tool_result> XML blocks from assistant text", () => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "text",
          text: [
            "I will read the file.",
            '<tool_call>{"name":"read","arguments":{"path":"/tmp/x"}}</tool_call>',
            '<tool_result>{"output":"hello world"}</tool_result>',
            "The file contains: hello world",
          ].join("\n"),
        },
      ],
    });

    expect(extractEmbeddedAssistantText(msg)).toBe(
      "I will read the file.\n\n\nThe file contains: hello world",
    );
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
        expected: "Pensando sobre el problema...",
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
        name: "antml namespaced thinking tag",
        text: "<antml:thinking>This shows Robin Waslander DMing maintainers o...</antml:thinking>Actual reply.",
        expected: "Actual reply.",
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
        content: [{ type: "text", text: testCase.text }],
      });
      expect(extractEmbeddedAssistantText(msg), testCase.name).toBe(testCase.expected);
    }
  });
});

describe("formatReasoningMessage", () => {
  it("returns empty string for whitespace-only input", () => {
    expect(formatReasoningMessage("   \n  \t  ")).toBe("");
  });

  it("wraps each line separately for multiline text (Telegram fix)", () => {
    expect(formatReasoningMessage("Line one\nLine two\nLine three")).toBe(
      "Thinking\n\n_Line one_\n_Line two_\n_Line three_",
    );
  });

  it("preserves empty lines between reasoning text", () => {
    expect(formatReasoningMessage("First block\n\nSecond block")).toBe(
      "Thinking\n\n_First block_\n\n_Second block_",
    );
  });

  it("trims leading/trailing whitespace", () => {
    expect(formatReasoningMessage("  \n  Reasoning here  \n  ")).toBe(
      "Thinking\n\n_Reasoning here_",
    );
  });
});

describe("extractAssistantThinking", () => {
  it("drops signature-only native reasoning blocks so no diagnostic bubble is surfaced", () => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "thinking",
          thinking: "",
          thinkingSignature: JSON.stringify({ type: "reasoning", id: "rs_live", summary: [] }),
        },
        { type: "text", text: "Done." },
      ],
    });

    // Signature-only block (no summary text) yields "" so downstream .filter(Boolean) drops it.
    expect(extractAssistantThinking(msg)).toBe("");
  });
});

describe("stripDowngradedToolCallText", () => {
  it.each([
    { input: "Hello [Historical context: example]  \n", expected: "Hello   \n" },
    {
      input: "Use `[Historical context: example]`  \n",
      expected: "Use `[Historical context: example]`  \n",
    },
  ])("preserves requested stream boundaries around $input", ({ input, expected }) => {
    expect(
      sanitizeAssistantVisibleStreamText(input, "final_answer", {
        preserveTrailingWhitespace: true,
      }),
    ).toBe(expected);
    expect(sanitizeAssistantVisibleStreamText(input, "final_answer")).toBe(expected.trimEnd());
  });
});

describe("extractAssistantVisibleText", () => {
  it.each(["Visible prefix <think>private reasoning tail", ""])(
    "captures legacy string content before it changes: %j",
    (content) => {
      const message = makeAssistantMessage({ content });
      const render = prepareAssistantVisibleText(message);
      message.content = [{ type: "text", text: "Replacement" }];

      expect(render()).toBe(content ? "Visible prefix" : "");
      expect(render()).toBe(content ? "Visible prefix" : "");
    },
  );

  it.each([
    { name: "plain text", text: "Done." },
    { name: "indented code", text: "    const value = 1;\n    use(value);" },
  ])("prefers non-empty final_answer $name over commentary", ({ text }) => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "text",
          text: "Working...",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text,
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
    });

    expect(extractAssistantVisibleText(msg)).toBe(text);
  });

  it("does not fall back to commentary when final_answer is empty", () => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "text",
          text: "Working...",
          textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
        },
        {
          type: "text",
          text: "   ",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
    });

    expect(extractAssistantVisibleText(msg)).toBe("");
  });

  it("does not fall back to unphased legacy text when an empty final_answer block exists", () => {
    const msg = makeAssistantMessage({
      content: [
        { type: "text", text: "Legacy answer" },
        {
          type: "text",
          text: "   ",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
    });

    expect(extractAssistantVisibleText(msg)).toBe("");
  });

  it("does not fall back to unphased legacy text when an empty output_text final_answer block exists", () => {
    const msg = makeAssistantMessage({
      content: [
        { type: "text", text: "Legacy answer" },
        {
          type: "output_text",
          text: "   ",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
    });

    expect(extractAssistantVisibleText(msg)).toBe("");
  });

  it("falls back to legacy unphased text when phased text is absent", () => {
    const msg = makeAssistantMessage({
      content: [{ type: "text", text: "Legacy answer" }],
    });

    expect(extractAssistantVisibleText(msg)).toBe("Legacy answer");
  });

  it("keeps strict reasoning-tag stripping for legacy string content", () => {
    const msg = makeAssistantMessage({
      content: "Visible prefix <think>private reasoning tail",
    });

    expect(extractAssistantVisibleText(msg)).toBe("Visible prefix");
  });

  it("preserves literal reasoning-looking tags in unphased visible text", () => {
    const msg = makeAssistantMessage({
      content: [
        {
          type: "text",
          text: "Before <think>literal tag text after",
          textSignature: JSON.stringify({ v: 1, id: "item_unphased" }),
        },
      ],
    });

    expect(extractAssistantVisibleText(msg)).toBe("Before <think>literal tag text after");
  });

  it("does not pull unphased legacy text into final_answer extraction when phased blocks are present", () => {
    const msg = makeAssistantMessage({
      phase: "final_answer",
      content: [
        { type: "text", text: "Legacy." },
        {
          type: "text",
          text: "Done.",
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
    });

    expect(extractAssistantVisibleText(msg)).toBe("Done.");
  });
});

describe("promoteThinkingTagsToBlocks", () => {
  it("preserves malformed null content entries while promoting thinking tags", () => {
    const msg = makeAssistantMessage({
      content: [null as never, { type: "text", text: "<thinking>hello</thinking>ok" }],
    });
    promoteThinkingTagsToBlocks(msg);
    const types = msg.content.map((b: { type?: string }) => b?.type);
    expect(types).toContain("thinking");
    expect(types).toContain("text");
  });

  it("splits antml namespaced thinking tags into thinking blocks", () => {
    const msg = makeAssistantMessage({
      content: [{ type: "text", text: "<antml:thinking>hidden</antml:thinking>Visible" }],
    });

    promoteThinkingTagsToBlocks(msg);
    expect(msg.content).toEqual([
      { type: "thinking", thinking: "hidden" },
      { type: "text", text: "Visible" },
    ]);
  });

  it("preserves undefined content entries when there are no thinking tags", () => {
    const msg = makeAssistantMessage({
      content: [undefined as never, { type: "text", text: "no tags here" }],
    });
    promoteThinkingTagsToBlocks(msg);
    expect(msg.content).toEqual([undefined, { type: "text", text: "no tags here" }]);
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
