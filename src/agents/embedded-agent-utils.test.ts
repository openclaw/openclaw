/**
 * Regression coverage for embedded-agent message text utilities.
 * Verifies visible text extraction, reasoning formatting, and thinking-tag promotion.
 */
import type { AssistantMessage } from "openclaw/plugin-sdk/llm";
import { describe, expect, it } from "vitest";
import { scanFenceSpans } from "../../packages/markdown-core/src/fences.js";
import { EmbeddedBlockChunker } from "./embedded-agent-block-chunker.js";
import { protectBreakIndex, scanUnbreakableSpans } from "./embedded-agent-link-spans.js";
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
  it("withholds a split runtime-context header until ordinary text diverges", () => {
    const privateStream = createAssistantVisibleStreamText();

    expect(privateStream.append("OpenClaw runtime cont")).toEqual({ text: "", delta: "" });
    expect(privateStream.append("ext:\nprivate\nEnd OpenClaw runtime context.\nVisible")).toEqual({
      text: "Visible",
      delta: "Visible",
    });

    const ordinaryStream = createAssistantVisibleStreamText();
    expect(ordinaryStream.append("OpenClaw runtime cont")).toEqual({ text: "", delta: "" });
    expect(ordinaryStream.append("rol is useful")).toEqual({
      text: "OpenClaw runtime control is useful",
      delta: "OpenClaw runtime control is useful",
    });
  });

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

  it("holds an incomplete GLM tool-call prefix and releases literal prose", () => {
    const stream = createAssistantVisibleStreamText();
    expect(stream.replace("Visible\n<tool_call>exec").text).toBe("Visible");
    expect(
      stream.replace("Use <tool_call>exec<arg_key> literally. Example: `</arg_key>`.").text,
    ).toBe("Use <tool_call>exec<arg_key> literally. Example: `</arg_key>`.");
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
    [
      "strips Minimax tool invocations with extra attributes",
      `Before<invoke name='Bash' data-foo="bar">\n<parameter name="command">ls</parameter>\n</invoke>\n</minimax:tool_call>After`,
      "Before\nAfter",
    ],
    [
      "strips minimax tool_call open and close tags",
      "Start<minimax:tool_call>Inner</minimax:tool_call>End",
      "StartInnerEnd",
    ],
    [
      "ignores invoke blocks without minimax markers",
      "Before<invoke>Keep</invoke>After",
      "Before<invoke>Keep</invoke>After",
    ],
    [
      "handles multiple invoke blocks in one message",
      `First check.<invoke name="Read">
<parameter name="path">file1.txt</parameter>
</invoke>
</minimax:tool_call>Second check.<invoke name="Bash">
<parameter name="command">pwd</parameter>
</invoke>
</minimax:tool_call>Done.`,
      "First check.\nSecond check.\nDone.",
    ],
    [
      "preserves trailing text after downgraded tool call blocks",
      `Intro text.
[Tool Call: read (ID: toolu_1)]
Arguments: {
  "path": "/tmp/file.txt"
}
Back to the user.`,
      "Intro text.\nBack to the user.",
    ],
    [
      "sanitizes HTTP-ish error text only when stopReason is error",
      "500 Internal Server Error",
      "HTTP 500: Internal Server Error",
      { stopReason: "error", errorMessage: "500 Internal Server Error" },
    ],
    [
      "preserves response when errorMessage set from background failure (#13935)",
      "Handle payment required errors in your API.",
      "Handle payment required errors in your API.",
      { stopReason: "stop", errorMessage: "insufficient credits for embedding model" },
    ],
    [
      "handles multiple text blocks",
      [
        "First block.",
        `<invoke name="Bash">
<parameter name="command">ls</parameter>
</invoke>
</minimax:tool_call>`,
        "Third block.",
      ],
      "First block.\nThird block.",
    ],
    [
      "handles multiple text blocks with tool calls and results",
      [
        "Here's what I found:",
        `[Tool Call: read (ID: toolu_1)]
Arguments: { "path": "/test.txt" }`,
        `[Tool Result for ID toolu_1]
File contents here`,
        "Done checking.",
      ],
      "Here's what I found:\nDone checking.",
    ],
    [
      "strips mixed <tool_call> and <tool_result> XML blocks from assistant text",
      [
        "I will read the file.",
        '<tool_call>{"name":"read","arguments":{"path":"/tmp/x"}}</tool_call>',
        '<tool_result>{"output":"hello world"}</tool_result>',
        "The file contains: hello world",
      ].join("\n"),
      "I will read the file.\n\n\nThe file contains: hello world",
    ],

    [
      "think tag",
      "<think>El usuario quiere retomar una tarea...</think>Aquí está tu respuesta.",
      "Aquí está tu respuesta.",
    ],
    ["think tag with attributes", `<think reason="deliberate">Hidden</think>Visible`, "Visible"],
    ["unclosed think tag", "<think>Pensando sobre el problema...", "Pensando sobre el problema..."],
    ["thinking tag", "Before<thinking>internal reasoning</thinking>After", "BeforeAfter"],
    [
      "antthinking tag",
      "<antthinking>Some reasoning</antthinking>The actual answer.",
      "The actual answer.",
    ],
    [
      "antml namespaced thinking tag",
      "<antml:thinking>This shows Robin Waslander DMing maintainers o...</antml:thinking>Actual reply.",
      "Actual reply.",
    ],
    ["final wrapper", "<final>\nAnswer\n</final>", "Answer"],
    ["thought tag", "<thought>Internal deliberation</thought>Final response.", "Final response."],
    [
      "multiple think blocks",
      "Start<think>first thought</think>Middle<think>second thought</think>End",
      "StartMiddleEnd",
    ],
  ] as const)("%s", (...[_name, input, expected, metadata]) => {
    const texts = typeof input === "string" ? [input] : input;
    const msg = makeAssistantMessage({
      ...metadata,
      content: texts.map((text) => ({ type: "text", text })),
    });
    expect(extractEmbeddedAssistantText(msg)).toBe(expected);
  });
});

describe("formatReasoningMessage", () => {
  it.each([
    ["returns empty string for empty input", "", ""],
    ["returns empty string for whitespace-only input", "   \n  \t  ", ""],
    [
      "wraps each line separately for multiline text (Telegram fix)",
      "Line one\nLine two\nLine three",
      "Thinking\n\n_Line one_\n_Line two_\n_Line three_",
    ],
    [
      "preserves empty lines between reasoning text",
      "First block\n\nSecond block",
      "Thinking\n\n_First block_\n\n_Second block_",
    ],
    [
      "trims leading/trailing whitespace",
      "  \n  Reasoning here  \n  ",
      "Thinking\n\n_Reasoning here_",
    ],
  ])("%s", (_name, text, expected) => {
    expect(formatReasoningMessage(text)).toBe(expected);
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
  it("withholds a partial runtime-context header from cumulative snapshots", () => {
    expect(sanitizeAssistantVisibleStreamText("OpenClaw runtime cont")).toBe("");
    expect(sanitizeAssistantVisibleStreamText("OpenClaw runtime control is useful")).toBe(
      "OpenClaw runtime control is useful",
    );
  });

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
    ["prefers non-empty final_answer plain text over commentary", "text", "Done.", "Done.", true],
    [
      "prefers non-empty final_answer indented code over commentary",
      "text",
      "    const value = 1;\n    use(value);",
      "    const value = 1;\n    use(value);",
      true,
    ],
    ["does not fall back to commentary when final_answer is empty", "text", "   ", "", true],
    [
      "does not fall back to unphased legacy text when an empty final_answer block exists",
      "text",
      "   ",
      "",
      false,
    ],
    [
      "does not fall back to unphased legacy text when an empty output_text final_answer block exists",
      "output_text",
      "   ",
      "",
      false,
    ],
  ] as const)("%s", (_name, type, text, expected, commentary) => {
    const msg = makeAssistantMessage({
      content: [
        commentary
          ? {
              type: "text",
              text: "Working...",
              textSignature: JSON.stringify({ v: 1, id: "item_commentary", phase: "commentary" }),
            }
          : { type: "text", text: "Legacy answer" },
        {
          type,
          text,
          textSignature: JSON.stringify({ v: 1, id: "item_final", phase: "final_answer" }),
        },
      ],
    });
    expect(extractAssistantVisibleText(msg)).toBe(expected);
  });

  it.each([
    [
      "falls back to legacy unphased text when phased text is absent",
      [{ type: "text", text: "Legacy answer" }],
      "Legacy answer",
    ],
    [
      "keeps strict reasoning-tag stripping for legacy string content",
      "Visible prefix <think>private reasoning tail",
      "Visible prefix",
    ],
  ])("%s", (_name, content, expected) => {
    expect(extractAssistantVisibleText(makeAssistantMessage({ content }))).toBe(expected);
  });

  it.each([
    [
      "preserves literal reasoning-looking tags in unphased visible text",
      "Before <think>literal tag text after",
      { v: 1, id: "item_unphased" },
      false,
    ],
    [
      "does not pull unphased legacy text into final_answer extraction when phased blocks are present",
      "Done.",
      { v: 1, id: "item_final", phase: "final_answer" },
      true,
    ],
  ] as const)("%s", (_name, text, signature, hasPhasedBlocks) => {
    const msg = makeAssistantMessage({
      ...(hasPhasedBlocks ? { phase: "final_answer" } : {}),
      content: [
        ...(hasPhasedBlocks ? [{ type: "text", text: "Legacy." }] : []),
        { type: "text", text, textSignature: JSON.stringify(signature) },
      ],
    });
    expect(extractAssistantVisibleText(msg)).toBe(text);
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

it("strips empty downgraded tool-call text", () => {
  expect(stripDowngradedToolCallText("")).toBe("");
});

describe("embedded agent link spans", () => {
  it("keeps paragraph separators before a protected link in delivered text", () => {
    const link = `[link](https://example.com/${"a".repeat(40)})`;
    const text = `First paragraph.\n\n${link}`;
    const chunker = new EmbeddedBlockChunker({ minChars: 10, maxChars: 30, hardMaxChars: 160 });
    const chunks: string[] = [];
    const source: string[] = [];
    chunker.append(text);
    chunker.drain({
      force: true,
      emit: (chunk, metadata) => {
        chunks.push(chunk);
        source.push(metadata?.sourceText ?? "");
      },
    });
    expect(chunks.join("")).toBe(text);
    expect(chunks.some((chunk) => chunk.includes(link))).toBe(true);
    expect(source.join("")).toBe(text);
    expect(chunks.every((chunk) => chunk.length <= 160)).toBe(true);
  });

  it("buffers a streamed reference definition until its destination is complete", () => {
    const text = `[ref]: https://example.com/${"a".repeat(40)}`;
    const chunker = new EmbeddedBlockChunker({ minChars: 10, maxChars: 30, hardMaxChars: 160 });
    const chunks: string[] = [];
    const emit = (chunk: string) => chunks.push(chunk);
    for (const character of text) {
      chunker.append(character);
      chunker.drain({ force: false, emit });
    }
    expect(chunks).toEqual([]);
    chunker.drain({ force: true, emit });
    expect(chunks).toEqual([text]);
    expect(chunker.hasBuffered()).toBe(false);
  });

  it("keeps a streamed link intact above the preferred size with contiguous source ranges", () => {
    const target =
      `https://outlook.office365.com/owa/?itemid=${"A".repeat(120)}` +
      "%3D%3D&exvsurl=1&path=/calendar/item";
    const link = `[invite](${target})`;
    const text = `Purpose: customer context. ${link}\n\nWhat matters`;
    const chunker = new EmbeddedBlockChunker({
      minChars: 20,
      maxChars: 48,
      hardMaxChars: 400,
      breakPreference: "paragraph",
    });
    const delivered: Array<{
      chunk: string;
      sourceText: string;
      sourceStart: number;
      sourceEnd: number;
    }> = [];
    const emit = (
      chunk: string,
      options?: { sourceText: string; sourceStart: number; sourceEnd: number },
    ) => {
      if (!options) {
        throw new Error("missing source metadata");
      }
      delivered.push({ chunk, ...options });
    };

    for (const character of text) {
      chunker.append(character);
      chunker.drain({ force: false, emit });
    }
    chunker.drain({ force: true, emit });

    expect(delivered.some(({ chunk }) => chunk.includes(link))).toBe(true);
    expect(delivered.map(({ sourceText }) => sourceText).join("")).toBe(text);
    expect(delivered.map(({ sourceStart, sourceEnd }) => [sourceStart, sourceEnd])).toEqual(
      delivered.map(({ sourceText }, index) => {
        const sourceStart = delivered
          .slice(0, index)
          .reduce((length, item) => length + item.sourceText.length, 0);
        return [sourceStart, sourceStart + sourceText.length];
      }),
    );
  });

  it("uses the outer parser-owned link span for a nested image", () => {
    const text = "[a![b](y)](z)";
    const spans = scanUnbreakableSpans(text, scanFenceSpans(text).spans, 30);

    expect(spans).toEqual([{ start: 0, end: text.length, complete: true }]);
    expect(protectBreakIndex(spans, 5, 0, false)).toBe(text.length);
  });

  it("does not protect a label that starts inside fenced code", () => {
    const text = `prose
\`\`\`
code [label
\`\`\`
](https://example.com/${"a".repeat(40)})`;

    const spans = scanUnbreakableSpans(text, scanFenceSpans(text).spans, 30);
    expect(spans.every((span) => span.start >= text.indexOf("https://"))).toBe(true);
  });

  it("does not protect a label that crosses fenced code", () => {
    const text = `Choose [a
\`\`\`js
${"code".repeat(20)}
\`\`\`
b](https://example.com/x) tail`;

    const spans = scanUnbreakableSpans(text, scanFenceSpans(text).spans, 30);
    expect(spans.every((span) => span.start >= text.indexOf("https://"))).toBe(true);
  });

  it("ignores brackets inside inline code while finding a link label", () => {
    const text = `See [use \`]\` here](https://example.com/${"a".repeat(40)})`;

    expect(scanUnbreakableSpans(text, [], 30)).toEqual([
      { start: text.indexOf("["), end: text.length, complete: true },
    ]);
  });

  it("recognizes a link after an unmatched backtick", () => {
    const text = `Unmatched \` then [invite](https://example.com/${"a".repeat(40)})`;

    expect(scanUnbreakableSpans(text, [], 160)).toEqual([
      { start: text.indexOf("["), end: text.length, complete: true },
    ]);
  });

  it("keeps a streamed long link intact after an unmatched backtick", () => {
    const link = `[invite](https://example.com/${"a".repeat(80)})`;
    const text = `Unmatched \` before ${link} after`;
    const chunker = new EmbeddedBlockChunker({
      minChars: 10,
      maxChars: 30,
      hardMaxChars: 160,
      breakPreference: "paragraph",
    });
    const chunks: string[] = [];
    const emit = (chunk: string) => chunks.push(chunk);

    for (const character of text) {
      chunker.append(character);
      chunker.drain({ force: false, emit });
    }
    chunker.drain({ force: true, emit });

    expect(chunks.some((chunk) => chunk.includes(link))).toBe(true);
  });

  it("keeps a fitting table with nested links whole", () => {
    const table = [
      "| Service | Link |",
      "| --- | --- |",
      "| Mail | [open](https://mail.example) |",
      "| Calendar | [open](https://calendar.example) |",
      "| Notes | plain |",
    ].join("\n");
    const chunker = new EmbeddedBlockChunker({
      minChars: 1,
      maxChars: 200,
      breakPreference: "newline",
    });
    const chunks: string[] = [];

    chunker.append(`${table}\n\n${"trailing prose ".repeat(20)}`);
    chunker.drain({ force: false, emit: (chunk) => chunks.push(chunk) });

    expect(chunks[0]?.slice(0, table.length)).toBe(table);
  });

  it("does not treat a label spanning a blank line as a link", () => {
    const text = `[label

paragraph](https://example.com/${"a".repeat(40)})`;

    const spans = scanUnbreakableSpans(text, scanFenceSpans(text).spans, 30);
    expect(spans.every((span) => span.start >= text.indexOf("https://"))).toBe(true);
  });

  it("does not complete a bare URL merely because the streamed suffix ends in >", () => {
    const text = `https://example.com/${"a".repeat(40)}>`;

    expect(scanUnbreakableSpans(text, [], 30)).toEqual([
      { start: 0, end: text.length, complete: false },
    ]);
  });
});
