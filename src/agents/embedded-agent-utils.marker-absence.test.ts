import { afterAll, beforeEach, expect, it, vi } from "vitest";
import * as markdownCodeRegions from "../../packages/markdown-core/src/markdown-code-regions.js";
import * as markdownOwnership from "../../packages/markdown-core/src/reasoning-tag-parser.js";
import * as reasoningSyntax from "../../packages/markdown-core/src/reasoning-tag-syntax.js";
import * as inboundMetadata from "../auto-reply/reply/strip-inbound-meta.js";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "../plugin-sdk/message-tool-delivery-hints.js";
import { assistantVisibleTextFilters } from "../shared/text/assistant-visible-text.js";
import { expectPrefixParity, streamChunks } from "../shared/text/streaming.test-support.js";
import { createTextProjection, trimTextPreservingCode } from "../shared/text/text-projection.js";
import { userFacingTextFilters } from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "./embedded-agent-utils.js";

// Observe canonical work across imports, including both code-range entry points:
// findMarkdownCodeSpans calls its local region binding without crossing an export spy.
const reasoning = vi.spyOn(reasoningSyntax, "reduceReasoningText");
const ownership = vi.spyOn(markdownOwnership, "parseMarkdownOwnership");
const regions = vi.spyOn(markdownCodeRegions, "findMarkdownCodeRegions");
const spans = vi.spyOn(markdownCodeRegions, "findMarkdownCodeSpans");
const canonicalWork = [reasoning, ownership, regions, spans];
const inbound = vi.spyOn(inboundMetadata, "stripInboundMetadata");
beforeEach(() => [...canonicalWork, inbound].forEach((spy) => spy.mockClear()));
afterAll(() => [...canonicalWork, inbound].forEach((spy) => spy.mockRestore()));
function characters(calls: ReadonlyArray<readonly [string, ...unknown[]]>) {
  return calls.reduce((sum, [text]) => sum + text.length, 0);
}
function processedCharacters() {
  return canonicalWork.reduce((sum, spy) => sum + characters(spy.mock.calls), 0);
}
it.each([
  [undefined, "Done.", 2],
  ["final_answer", "Done.", 2],
  [undefined, "<think>hidden</think>Done.", 8],
  [undefined, "<final>Done.</final>", 8],
] as const)("bounds transform work (%s, %s)", (phase, tail, budget) => {
  const prefix = "<article>Array<string>: a < b and c > d.</article>\n".repeat(96);
  const stream = createAssistantVisibleStreamText(phase);
  streamChunks(prefix, 4, stream);
  if (budget === 2) {
    streamChunks(tail, 4, stream);
  } else {
    stream.append(tail);
  }
  expect(stream.text).toBe(prefix + "Done.");
  if (tail.startsWith("<think>")) {
    expect(characters(reasoning.mock.calls)).toBeGreaterThan(0);
  }
  expect(processedCharacters()).toBeLessThan((prefix.length + tail.length) * budget);
});

it.each([
  ["<div>Array<string>: a < b and c > d.</div>"],
  ["<thinking-about>literal</thinking-about><finalizing>literal</finalizing>"],
  ["< \u00a0AnTmL:ThiNking >secret< / antml:thinking >Answer", "Answer"],
  ["<mm:thought>secret</mm:thought>Answer", "Answer"],
  ["<internal>secret</internal>Answer", "Answer"],
  ['<think note="a>b">secret</think>Answer', "Answer"],
  ['<thinking x="<internal>private reflection</internal>', '<thinking x="'],
  ["<div>Visible</div><final> Tail</final>", "<div>Visible</div> Tail"],
  ['<final reason="a>b">visible'],
  ["```xml\n<think>literal</think>\n<final>literal</final>\n```\nDone."],
  [`<${" ".repeat(128)}/${"\t".repeat(128)}ThiNKing>Answer`, "Answer"],
  ["Before <final data-note='ok'>Answer</final> After", "Before Answer After"],
  ["< / FINAL >Answer", "Answer"],
  ["<final /bare>literal", "<final /bare>literal"],
  ["<final-result>literal</final-result>", "<final-result>literal</final-result>"],
])("preserves every prefix and final output for %s", (source, expected = source) => {
  expect(
    expectPrefixParity(
      source,
      createAssistantVisibleStreamText,
      sanitizeAssistantVisibleStreamText,
    ),
  ).toBe(expected);
});

it.each(["<think>hidden</think>", "<final>"])(
  "restarts probes after upstream replacement: %s",
  (marker) => {
    const stream = createTextProjection([
      {
        transform: (text) => text.replace("rewrite:", marker),
        activationTokens: ["rewrite:"],
      },
      ...assistantVisibleTextFilters("delivery", true),
      ...userFacingTextFilters(false, true),
    ]);
    expect(stream.append("rewrite").text).toBe("rewrite");
    expect(stream.append(":Answer")).toEqual({ text: "Answer", delta: null });
    expect(stream.append("<div>next</div>").text).toBe("Answer<div>next</div>");
  },
);

it("resets rejected and activated heads after replacement", () => {
  const stream = createAssistantVisibleStreamText();
  const literal = "<finalizing>literal</finalizing>";
  expect(stream.append("<div>First</div>").text).toBe("<div>First</div>");
  expect(stream.replace("<thi").text).toBe("<thi");
  expect(stream.append("nk>secret</think>Answer").text).toBe("Answer");
  expect(stream.replace(literal).text).toBe(literal);
  expect(stream.append("<final>Tail</final>").text).toBe(literal + "Tail");
  expect(stream.replace("").text).toBe("");
  expect(stream.append("< / final >Fresh").text).toBe("Fresh");
});

it.each(["[docs](https://example.com) ", "Context: "])(
  "bounds inbound-metadata work after ordinary %s with append and replacement starts",
  (prefix) => {
    const body = "The operator reads the next line. ".repeat(128) + "Done.";
    for (const replace of [false, true]) {
      inbound.mockClear();
      const stream = createAssistantVisibleStreamText();
      if (replace) {
        stream.replace(prefix);
      } else {
        streamChunks(prefix, 1, stream);
      }
      streamChunks(body, 4, stream);
      expect(stream.text).toBe(prefix + body);
      expect(characters(inbound.mock.calls)).toBeLessThan((prefix.length + body.length) * 2);
    }
  },
);

it.each([
  "[Mon 2026-10-24 12:34 UTC] Visible answer",
  ...MESSAGE_TOOL_DELIVERY_HINTS.map((hint) => `${hint}\nVisible answer`),
  `[Mon 2026-10-24 12:34 ${"long timezone ".repeat(16)}] Visible answer`,
  "[docs](https://example.com)\nContext: ordinary prose",
  "[^note]: Ordinary footnote\nInline Context: prose",
  "\n\tContext: \t\r\n<active_memory_plugin>\nPrivate context\n</active_memory_plugin>\n\nVisible answer",
  'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"id":"synthetic"}\n```\n\nVisible answer',
  ...["\u2028", "\u2029"].flatMap((boundary) => [
    `Before.\n${boundary}Context:\n<active_memory_plugin>\nPrivate context\n</active_memory_plugin>\n\nVisible answer`,
    `Before.\nContext:${boundary}\n<active_memory_plugin>\nPrivate context\n</active_memory_plugin>\n\nVisible answer`,
  ]),
])("preserves canonical inbound filtering across every split: %s", (source) => {
  const stream = createAssistantVisibleStreamText("final_answer");
  expectPrefixParity(
    source,
    () => {
      stream.replace("");
      return stream;
    },
    (prefix) => trimTextPreservingCode(sanitizeAssistantVisibleStreamText(prefix, "final_answer")),
  );
  stream.replace("[ordinary] Context: literal");
  expect(stream.append(" answer").text).toBe("[ordinary] Context: literal answer");
});
