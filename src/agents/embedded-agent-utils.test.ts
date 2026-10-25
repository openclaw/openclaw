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
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

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
    ...makeAgentAssistantMessage({ content: [], model: "gpt-5", timestamp: 1 }),
    api: "responses",
    ...message,
  } as unknown as AssistantMessage;
}

const textBlock = (text: string) => ({ type: "text" as const, text });
const phasedText = (text: string, phase?: "commentary" | "final_answer", type = "text") => ({
  type,
  text,
  textSignature: JSON.stringify({ v: 1, id: `item_${phase ?? "unphased"}`, phase }),
});
const textMessage = (...texts: string[]) => makeAssistantMessage({ content: texts.map(textBlock) });

describe("createAssistantVisibleStreamText", () => {
  it.each([
    [
      "an open image description when its inline destination closes",
      "![example `x\n[tool:read] {}\nx` label",
      "](/url)\n",
    ],
    [
      "a multiline reference title when its closing quote arrives",
      '[id]: /url\n"title\n`x\n[tool:read] {}\nx` trailing\n',
      '"',
    ],
    [
      "a reference image when its next-line destination arrives",
      "![example `x\n[tool:read] {}\nx`][id]\n\n[id]:\n",
      "/url\n",
    ],
  ])("recomputes final-answer ownership after %s", (_name, prefix, suffix) => {
    const stream = createAssistantVisibleStreamText("final_answer");
    expect(stream.append(prefix).text).toContain("[tool:read]");

    const result = stream.append(suffix);
    expect(result.delta).toBeNull();
    expect(result.text).toBe(sanitizeAssistantVisibleStreamText(prefix + suffix, "final_answer"));
    expect(result.text).not.toContain("[tool:read]");
  });

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
  const invoke =
    '<invoke name="Bash">\n<parameter name="command">ls</parameter>\n</invoke>\n</minimax:tool_call>';
  it.each([
    [
      [`Before${invoke.replace('name="Bash"', "name='Bash' data-foo=\"bar\"")}After`],
      "Before\nAfter",
    ],
    [["Start<minimax:tool_call>Inner</minimax:tool_call>End"], "StartInnerEnd"],
    [["Before<invoke>Keep</invoke>After"], "Before<invoke>Keep</invoke>After"],
    [[`First check.${invoke}Second check.${invoke}Done.`], "First check.\nSecond check.\nDone."],
    [
      [
        'Intro text.\n[Tool Call: read (ID: toolu_1)]\nArguments: {\n  "path": "/tmp/file.txt"\n}\nBack to the user.',
      ],
      "Intro text.\nBack to the user.",
    ],
    [["First block.", invoke, "Third block."], "First block.\nThird block."],
    [
      [
        "Here's what I found:",
        '[Tool Call: read (ID: toolu_1)]\nArguments: { "path": "/test.txt" }',
        "[Tool Result for ID toolu_1]\nFile contents here",
        "Done checking.",
      ],
      "Here's what I found:\nDone checking.",
    ],
    [
      [
        'I will read the file.\n<tool_call>{"name":"read","arguments":{"path":"/tmp/x"}}</tool_call>\n<tool_result>{"output":"hello world"}</tool_result>\nThe file contains: hello world',
      ],
      "I will read the file.\n\n\nThe file contains: hello world",
    ],
  ] as const)("sanitizes assistant text blocks: %j", (texts, expected) => {
    expect(extractEmbeddedAssistantText(textMessage(...texts))).toBe(expected);
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

  it("strips reasoning/thinking tag variants", () => {
    for (const [text, expected] of [
      [
        "<think>El usuario quiere retomar una tarea...</think>Aquí está tu respuesta.",
        "Aquí está tu respuesta.",
      ],
      ['<think reason="deliberate">Hidden</think>Visible', "Visible"],
      ["<think>Pensando sobre el problema...", "Pensando sobre el problema..."],
      ["Before<thinking>internal reasoning</thinking>After", "BeforeAfter"],
      ["<antthinking>Some reasoning</antthinking>The actual answer.", "The actual answer."],
      ["<antml:thinking>Private reasoning</antml:thinking>Actual reply.", "Actual reply."],
      ["<final>\nAnswer\n</final>", "Answer"],
      ["<thought>Internal deliberation</thought>Final response.", "Final response."],
      ["Start<think>first thought</think>Middle<think>second thought</think>End", "StartMiddleEnd"],
    ] as const) {
      expect(extractEmbeddedAssistantText(textMessage(text)), text).toBe(expected);
    }
  });
});

describe("formatReasoningMessage", () => {
  it.each([
    ["   \n  \t  ", ""],
    ["Line one\nLine two\nLine three", "Thinking\n\n_Line one_\n_Line two_\n_Line three_"],
    ["First block\n\nSecond block", "Thinking\n\n_First block_\n\n_Second block_"],
    ["  \n  Reasoning here  \n  ", "Thinking\n\n_Reasoning here_"],
  ])("formats reasoning line-by-line (Telegram regression): %j", (input, expected) => {
    expect(formatReasoningMessage(input)).toBe(expected);
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
  const commentary = phasedText("Working...", "commentary");
  const legacy = textBlock("Legacy answer");
  const code = "    const value = 1;\n    use(value);";
  const literal = "Before <think>literal tag text after";
  const final = (text: string, type = "text") => phasedText(text, "final_answer", type);
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
    ["plain final", [commentary, final("Done.")], "Done."],
    ["indented final", [commentary, final(code)], code],
    ["empty final after commentary", [commentary, final("   ")], ""],
    ["empty final after legacy text", [legacy, final("   ")], ""],
    ["empty output_text final", [legacy, final("   ", "output_text")], ""],
    ["legacy fallback", [legacy], "Legacy answer"],
    ["literal reasoning tag", [phasedText(literal)], literal],
    ["no legacy mixing", [textBlock("Legacy."), final("Done.")], "Done.", "final_answer"],
  ] as const)("selects visible text: %s", (_name, content, expected, phase) => {
    expect(extractAssistantVisibleText(makeAssistantMessage({ content, phase }))).toBe(expected);
  });
});

describe("promoteThinkingTagsToBlocks", () => {
  it.each([
    [
      [null, textBlock("<thinking>hello</thinking>ok")],
      [null, { type: "thinking", thinking: "hello" }, textBlock("ok")],
    ],
    [
      [textBlock("<antml:thinking>hidden</antml:thinking>Visible")],
      [{ type: "thinking", thinking: "hidden" }, textBlock("Visible")],
    ],
    [
      [undefined, textBlock("no tags here")],
      [undefined, textBlock("no tags here")],
    ],
  ])("promotes tags without losing malformed entries: %j", (content, expected) => {
    const msg = makeAssistantMessage({ content });
    promoteThinkingTagsToBlocks(msg);
    expect(msg.content).toEqual(expected);
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
