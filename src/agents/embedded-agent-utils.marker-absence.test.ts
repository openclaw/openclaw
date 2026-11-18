import { expect, it } from "vitest";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "../plugin-sdk/message-tool-delivery-hints.js";
import { assistantVisibleTextFilters } from "../shared/text/assistant-visible-text.js";
import { expectPrefixParity, streamChunks } from "../shared/text/streaming.test-support.js";
import { createTextProjection, trimTextPreservingCode } from "../shared/text/text-projection.js";
import { userFacingTextFilters } from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "./embedded-agent-utils.js";

it.each([
  [undefined, "Done."],
  ["final_answer", "Done."],
  [undefined, "<think>hidden</think>Done."],
  [undefined, "<final>Done.</final>"],
] as const)("preserves ordinary HTML and a late reasoning marker (%s, %s)", (phase, tail) => {
  const prefix = "<article>Array<string>: a < b and c > d.</article>\n";
  const stream = createAssistantVisibleStreamText(phase);
  streamChunks(prefix, 4, stream);
  stream.append(tail);
  expect(stream.text).toBe(prefix + "Done.");
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
  "preserves ordinary %s with append and replacement starts",
  (prefix) => {
    const body = "The operator reads the next line. Done.";
    for (const replace of [false, true]) {
      const stream = createAssistantVisibleStreamText();
      if (replace) {
        stream.replace(prefix);
      } else {
        streamChunks(prefix, 1, stream);
      }
      streamChunks(body, 4, stream);
      expect(stream.text).toBe(prefix + body);
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
