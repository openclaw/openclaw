import { beforeEach, describe, expect, it, vi } from "vitest";
import * as reasoningTagParser from "../../../markdown-core/src/reasoning-tag-parser.js";
import {
  createReasoningTagTextPartitioner,
  type ReasoningTagTextDelta,
} from "./reasoning-tag-text-partitioner.js";

describe("createReasoningTagTextPartitioner", () => {
  let partitioner: ReturnType<typeof createReasoningTagTextPartitioner>;
  beforeEach(() => {
    partitioner = createReasoningTagTextPartitioner();
  });
  const bytes = (input: string) => Array.from({ length: input.length }, (_, index) => index + 1);
  function collect(deltas: ReasoningTagTextDelta[]) {
    const join = (kind: ReasoningTagTextDelta["kind"]) =>
      deltas
        .filter((delta) => delta.kind === kind)
        .map((delta) => delta.text)
        .join("");
    return { text: join("text"), thinking: join("thinking") };
  }
  function collectVisibleMode(input: string, splitPoints: readonly number[]) {
    const stream = createReasoningTagTextPartitioner();
    const deltas: ReasoningTagTextDelta[] = [];
    let start = 0;
    for (const end of [...splitPoints, input.length]) {
      deltas.push(...stream.pushVisible(input.slice(start, end)));
      start = end;
    }
    deltas.push(...stream.flush());
    return collect(deltas);
  }
  function expectBoundedStream(
    chunk: string,
    count: number,
    prefix = "",
    suffix = "",
    limit = 5_000,
  ) {
    const startedAt = Date.now();
    const deltas = prefix ? partitioner.pushVisible(prefix) : [];
    for (let index = 0; index < count; index += 1) {
      deltas.push(...partitioner.pushVisible(chunk));
    }
    if (suffix) {
      deltas.push(...partitioner.pushVisible(suffix));
    }
    deltas.push(...partitioner.flush());
    expect(deltas.filter((delta) => delta.kind === "thinking")).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(limit);
  }
  function expectCompactedProse(chunk: string, prefix: string, length: number) {
    const startedAt = Date.now();
    const emittedLength = (text: string) =>
      partitioner.pushVisible(text).reduce((total, delta) => total + delta.text.length, 0);
    let total = prefix ? emittedLength(prefix) : 0;
    for (let index = 0; index < 2_000; index += 1) {
      total += emittedLength(chunk);
    }
    expect(total).toBe(length);
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.flush()).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  }
  it.each([
    {
      name: "self-closing tags are depth-neutral",
      input: "Before<thinking/>After",
      text: "BeforeAfter",
    },
    {
      name: "adjacent orphan closes keep prior valid output",
      input: "Before<think>x</think></think>After",
      text: "Before</think>After",
      thinking: "x",
    },
    {
      name: "quoted greater-than delimiters do not end tags",
      input: 'Before <think data-x=">">hidden</think> After',
      text: "Before  After",
      thinking: "hidden",
    },
    {
      name: "provider tags retain the previous Unicode whitespace grammar",
      input: "<think\u00a0>hidden</think>After",
      text: "After",
      thinking: "hidden",
    },
    {
      name: "unequal backtick runs do not own reasoning",
      input: "before ```<think>private</think>`` after",
      text: "before ````` after",
      thinking: "private",
    },
    {
      name: "a closing backtick run is not stable before its following byte",
      input: "`<think>x</think> ```a```",
      text: "` ```a```",
      thinking: "x",
    },
    {
      name: "a stable code span does not release a later unresolved delimiter",
      input: "    `|\n``<think>x</think>\n``",
    },
    {
      name: "a stable inline span does not carry code certainty across a new block",
      input: "`x`\n>     ~~~<think>x</think>- <thinking/>\n\n",
    },
    {
      name: "tag release retains a partial indentation prefix for the next chunk",
      input: "\na<thinking/>\n\n\n    ~~~<thinking/>- \n",
      text: "\na\n\n\n    ~~~<thinking/>- \n",
    },
    {
      name: "a lone carriage return invalidates same-line code certainty",
      input: "a<thinking/>\r\r    <think>x</think>",
      text: "a\r\r    <think>x</think>",
    },
    {
      name: "one CRLF is not mistaken for a blank block boundary",
      input: "a\r\n    <think>x</think>",
      text: "a\r\n    ",
      thinking: "x",
    },
    {
      name: "a whitespace-only CRLF blank line starts a new indented code block",
      input: "a\r\n \t\r\n    <think>x</think>",
    },
    {
      name: "compaction retains context for a following empty list item",
      input: "    `\n\n-\n      <think>x</think>",
      text: "    `\n\n-\n      ",
      thinking: "x",
    },
    {
      name: "paragraph-to-list transitions end inline code",
      input: "Paragraph `literal\n- <think>private</think> `visible",
      text: "Paragraph `literal\n-  `visible",
      thinking: "private",
    },
    {
      name: "soft line breaks retain inline-code ownership",
      input: "Paragraph `literal\ncontinued <think>example</think>` after",
    },
    {
      name: "fast-path tags stop before later inline code",
      input: "<thinking/> text `<think>literal</think>`",
      text: " text `<think>literal</think>`",
    },
    {
      name: "fast-path tags stop before newline-owned code",
      input: "- aa <thinking/>\n\n1.       <think>literal</think>",
      text: "- aa \n\n1.       <think>literal</think>",
    },
    {
      name: "blockquote inline code retains its container context",
      input: "> Before `<think>literal</think>\n> after` tail",
    },
    {
      name: "list-item inline code retains its container context",
      input: "- Before `\n  <think>literal</think>\n  after` tail",
    },
    {
      name: "list continuation indentation retains its container context",
      input: "- item\n\n    <think>private</think>\n",
      text: "- item\n\n    \n",
      thinking: "private",
    },
    {
      name: "blockquote fences preserve literal tags",
      input: "> ```xml\n> <think>literal</think>\n> ```\n> tail",
    },
    {
      name: "blockquote-relative indented code preserves literal tags",
      input: ">     <think>literal</think>",
    },
    {
      name: "list-owned tilde fences preserve literal tags",
      input: "- ~~~xml\n  <think>literal</think>\n  ~~~\n",
    },
    {
      name: "indented code preserves literal tags",
      input: "    <think>literal</think>",
    },
    {
      name: "late indented-code events do not replay the next paragraph",
      input: "    code\n<think>private</think>\n",
      text: "    code\n\n",
      thinking: "private",
    },
    {
      name: "a closing fence is not reused as context for the next block",
      input: " ```\ncode\n```\n\n<think>private</think>",
      text: " ```\ncode\n```\n\n",
      thinking: "private",
    },
    {
      name: "GFM table code spans preserve literal tags",
      input: "| a | b |\n| - | - |\n| `<think>literal</think>` | y |",
    },
    {
      name: "escaped backticks do not own reasoning",
      input: "before \\`<think>private</think>\\` after",
      text: "before \\`\\` after",
      thinking: "private",
    },
    {
      name: "link destinations do not create code spans",
      input: "[label](url`x) <think>private</think> (y`) after",
      text: "[label](url`x)  (y`) after",
      thinking: "private",
    },
    {
      name: "table cells do not share inline-code ownership",
      input: "| A | B |\n| - | - |\n| `x | <think>private</think> |\n| y` | z |",
      text: "| A | B |\n| - | - |\n| `x |  |\n| y` | z |",
      thinking: "private",
    },
  ])("is invariant at every chunk boundary: $name", ({ input, text = input, thinking = "" }) => {
    const expected = { text, thinking };
    expect(collectVisibleMode(input, [])).toEqual(expected);
    for (let split = 0; split <= input.length; split += 1) {
      expect(collectVisibleMode(input, [split])).toEqual(expected);
    }
    expect(collectVisibleMode(input, bytes(input))).toEqual(expected);
  });
  it("recovers a byte-streamed 110KB malformed quoted tag without reparsing prefixes", () => {
    const input = `<think data-x="${"x".repeat(110_000)}<think>hidden</think>After`;
    let parsedCharacters = 0;
    const parserSpies = (
      ["parseReasoningTagAt", "scanReasoningTags", "parseMarkdownOwnership"] as const
    ).map((name) => {
      const original = reasoningTagParser[name];
      return vi
        .spyOn(reasoningTagParser, name)
        .mockImplementation((text: string, ...args: unknown[]) => {
          // Bound reparsed input independently of runner speed, and fail before quadratic work.
          parsedCharacters += text.length;
          expect(parsedCharacters).toBeLessThanOrEqual(input.length * 4);
          return Reflect.apply(original, undefined, [text, ...args]);
        });
    });
    try {
      const result = collectVisibleMode(input, bytes(input));
      expect(result.text).not.toContain("hidden");
      expect(result.text.endsWith("After")).toBe(true);
      expect(result.thinking).toBe("hidden");
    } finally {
      for (const spy of parserSpies) {
        spy.mockRestore();
      }
    }
  });
  it("bounds parser-owned reparsing across many code-bearing blocks", () => {
    expectBoundedStream("`literal` <thinking/>\n\n", 1_600, "", "", 10_000);
  });
  it("does not repeatedly reparse a growing list container", () => {
    expectBoundedStream("  `literal`\n\n", 800, "- item\n");
  });
  it("does not repeatedly reparse a growing unclosed tilde fence", () => {
    expectBoundedStream("<thinking/>\n", 3_200, "~~~xml\n", "~~~\ntail");
  });
  it("compacts blank-only streams without retaining an empty tree", () => {
    const startedAt = Date.now();
    for (let index = 0; index < 5_000; index += 1) {
      expect(partitioner.pushVisible("\n\n")).toEqual([{ kind: "text", text: "\n\n" }]);
    }
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.flush()).toEqual([]);
    expect(Date.now() - startedAt).toBeLessThan(5_000);
  });
  it("compacts top-level prose after a completed list block", () => {
    expectCompactedProse("plain\n\n", "- item\n\n", 14_008);
  });
  it("compacts blank boundaries containing horizontal whitespace", () => {
    expectCompactedProse("plain\n \t\n", "", 18_000);
  });
  it("streams one parser-proven code span inside a retained list", () => {
    expect(partitioner.pushVisible("- use `code` now")).toEqual([
      { kind: "text", text: "- use `code` now" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });
  it("releases an escaped backtick at a completed block boundary", () => {
    expect(partitioner.pushVisible("Use \\` literally\n\n")).toEqual([
      { kind: "text", text: "Use \\` literally\n\n" },
    ]);
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.flush()).toEqual([]);
  });
  it("starts a new bounded parse epoch after a committed flat paragraph prefix", () => {
    expect(partitioner.pushVisible("Use `code` now")).toEqual([
      { kind: "text", text: "Use `code` now" },
    ]);
    expect(partitioner.pushVisible("<think>x</think>After")).toEqual([
      { kind: "thinking", text: "x" },
      { kind: "text", text: "After" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });
  it("retains unresolved link context after releasing a stable code span", () => {
    const deltas = [
      ...partitioner.pushVisible("Use `code` now [label]("),
      ...partitioner.pushVisible("url`x) <think>private</think> (y`) after"),
      ...partitioner.flush(),
    ];
    expect(collect(deltas)).toEqual({
      text: "Use `code` now [label](url`x)  (y`) after",
      thinking: "private",
    });
  });
  it("streams a split multiline reasoning block when its close arrives", () => {
    expect(partitioner.pushVisible("<think>\n")).toEqual([]);
    expect(partitioner.pushVisible("secret\n</think>answer")).toEqual([
      { kind: "thinking", text: "\nsecret\n" },
      { kind: "text", text: "answer" },
    ]);
    expect(partitioner.flush()).toEqual([]);
  });
  it("waits for GFM table lookahead before releasing a header code span", () => {
    const deltas = [
      ...partitioner.pushVisible("| `x | <think>private</think> | y` |\n"),
      ...partitioner.pushVisible("| - | - | - |\n"),
      ...partitioner.pushVisible("tail"),
      ...partitioner.flush(),
    ];
    expect(collect(deltas)).toEqual({
      text: "| `x |  | y` |\n| - | - | - |\ntail",
      thinking: "private",
    });
  });
  it("does not compact an unclosed top-level fence at a blank line", () => {
    const input = ["~~~xml\n<think>literal1</think>\n\n", "<think>literal2</think>\n~~~\n", "tail"];
    const deltas = [
      ...partitioner.pushVisible(input[0] ?? ""),
      ...partitioner.pushVisible(input[1] ?? ""),
      ...partitioner.pushVisible(input[2] ?? ""),
      ...partitioner.flush(),
    ];
    expect(collect(deltas).text).toBe(input.join(""));
    expect(deltas.filter((delta) => delta.kind === "thinking")).toEqual([]);
  });
  it("releases a split tag prefix as soon as its name becomes invalid", () => {
    expect(partitioner.pushVisible("<thi")).toEqual([]);
    expect(partitioner.pushVisible("x ordinary text")).toEqual([
      { kind: "text", text: "<thix ordinary text" },
    ]);
  });
  it("releases definitely invalid empty-name prefixes", () => {
    expect(partitioner.pushVisible("</")).toEqual([]);
    expect(partitioner.pushVisible("!ordinary")).toEqual([{ kind: "text", text: "</!ordinary" }]);
  });
  it("does not replay emitted text when strict mode starts", () => {
    expect(partitioner.pushVisible("abc")).toEqual([{ kind: "text", text: "abc" }]);
    partitioner.markStrict();
    expect(partitioner.hasPending()).toBe(false);
    expect(partitioner.push("def")).toEqual([]);
    expect(partitioner.flush()).toEqual([{ kind: "text", text: "def" }]);
  });
  it("keeps strict orphan-close recovery global across block boundaries", () => {
    const deltas = [
      ...partitioner.push("private chain\n\n"),
      ...partitioner.push("</think> Visible answer"),
      ...partitioner.flush(),
    ];
    expect(deltas).toEqual([{ kind: "text", text: " Visible answer" }]);
  });
  it("keeps close tags inside list-owned fences hidden from an outer reasoning block", () => {
    const input = [
      "<think>\n",
      "- ~~~xml\n",
      "  </think> literal close\n",
      "  ~~~\n",
      "still private</think>Visible",
    ].join("");
    expect(collectVisibleMode(input, []).text).toBe("Visible");
    expect(collectVisibleMode(input, bytes(input)).text).toBe("Visible");
  });
  it("keeps split mm reasoning tags out of visible text", () => {
    const deltas = [
      ...partitioner.push("Before <mm:thi"),
      ...partitioner.push("nk>secret</mm:think> after"),
      ...partitioner.flush(),
    ];
    expect(deltas).toEqual([
      { kind: "text", text: "Before " },
      { kind: "thinking", text: "secret" },
      { kind: "text", text: " after" },
    ]);
  });
  it("keeps close tags inside hidden code fences private", () => {
    expect(partitioner.pushVisible("<think>\n```ts\nliteral ")).toEqual([]);
    expect(partitioner.pushVisible("</think> still private")).toEqual([]);
    expect(partitioner.flush()).toEqual([
      { kind: "thinking", text: "\n```ts\nliteral </think> still private" },
    ]);
  });
  it("recovers fully wrapped unclosed visible-mode text on flush", () => {
    expect(partitioner.pushVisible("<think>Visible answer from a malformed local model")).toEqual(
      [],
    );
    expect(partitioner.flush()).toEqual([
      { kind: "text", text: "Visible answer from a malformed local model" },
    ]);
  });
  it("keeps unclosed trailing tags as visible prose in visible mode", () => {
    expect(partitioner.pushVisible("Use <think> only in this mode")).toEqual([
      { kind: "text", text: "Use " },
    ]);
    expect(partitioner.flush()).toEqual([{ kind: "text", text: "<think> only in this mode" }]);
  });
  it("reclassifies reasoning tags inside unclosed inline code on final flush", () => {
    expect(partitioner.pushVisible("Start `unclosed <think>secret</think> end")).toEqual([]);
    expect(partitioner.isInsideReasoning()).toBe(false);
    expect(partitioner.flush()).toEqual([
      { kind: "text", text: "Start `unclosed " },
      { kind: "thinking", text: "secret" },
      { kind: "text", text: " end" },
    ]);
  });
  it("keeps buffered unclosed reasoning hidden after strict mode is marked", () => {
    expect(partitioner.pushVisible("<think>secret")).toEqual([]);
    partitioner.markStrict();
    expect(partitioner.flush()).toEqual([{ kind: "thinking", text: "secret" }]);
  });
  it("distinguishes buffered syntax from strict visible text", () => {
    const syntax = createReasoningTagTextPartitioner();
    const visible = createReasoningTagTextPartitioner();
    expect(syntax.pushVisible("Use `<thi")).toEqual([]);
    expect(syntax.hasPendingSyntax()).toBe(true);

    visible.markStrict();
    expect(visible.pushVisible("Interim answer.")).toEqual([]);
    expect(visible.hasPending()).toBe(true);
    expect(visible.hasPendingSyntax()).toBe(false);
  });
  it("accepts later content after an intermediate flush boundary", () => {
    expect(partitioner.pushVisible("before")).toEqual([{ kind: "text", text: "before" }]);
    expect(partitioner.flush()).toEqual([]);
    expect(partitioner.pushVisible("after")).toEqual([{ kind: "text", text: "after" }]);
    expect(partitioner.flush()).toEqual([]);
  });
  it("keeps a completed nested region private when its outer tag is unclosed", () => {
    expect(partitioner.pushVisible("<think>outer<think>inner</think>")).toEqual([]);
    expect(partitioner.flush()).toEqual([{ kind: "thinking", text: "outerinner" }]);
  });
  it("never emits nested unclosed internal reflection on flush", () => {
    expect(partitioner.pushVisible("<thinking>outer<internal>private reflection")).toEqual([]);
    expect(partitioner.flush()).toEqual([]);
  });
  it("never emits closed internal reflection", () => {
    expect(partitioner.pushVisible("<internal>private reflection</internal>")).toEqual([]);
    expect(partitioner.flush()).toEqual([]);
  });
});
