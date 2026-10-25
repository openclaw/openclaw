import { afterAll, beforeEach, expect, it, vi } from "vitest";
import * as inboundMetadata from "../auto-reply/reply/strip-inbound-meta.js";
import { MESSAGE_TOOL_DELIVERY_HINTS } from "../plugin-sdk/message-tool-delivery-hints.js";
import { assistantVisibleTextFilters } from "../shared/text/assistant-visible-text.js";
import * as finalTags from "../shared/text/final-tags.js";
import * as reasoningTags from "../shared/text/reasoning-tags.js";
import { createTextProjection } from "../shared/text/text-projection.js";
import {
  sanitizeUserFacingText,
  userFacingTextFilters,
} from "./embedded-agent-helpers/sanitize-user-facing-text.js";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "./embedded-agent-utils.js";

// Filter arrays cache their transforms, so keep the same spies for the entire module.
const reasoning = vi.spyOn(reasoningTags, "stripReasoningTagsFromText");
const final = vi.spyOn(finalTags, "stripFinalTags");
const inbound = vi.spyOn(inboundMetadata, "stripInboundMetadata");
const transforms = [reasoning, final, inbound];
beforeEach(() => transforms.forEach((spy) => spy.mockClear()));
afterAll(() => transforms.forEach((spy) => spy.mockRestore()));
function characters(calls: ReadonlyArray<readonly [string, ...unknown[]]>) {
  return calls.reduce((sum, [text]) => sum + text.length, 0);
}
function appendChunks(stream: ReturnType<typeof createTextProjection>, text: string, size: number) {
  for (let offset = 0; offset < text.length; offset += size) {
    stream.append(text.slice(offset, offset + size));
  }
}

it.each([undefined, "final_answer"] as const)(
  "bounds ordinary-markup transform work (%s)",
  (phase) => {
    const source = "<article>Array<string>: a < b and c > d.</article>\n".repeat(96) + "Done.";
    const stream = createAssistantVisibleStreamText(phase);
    appendChunks(stream, source, 4);
    expect(stream.text).toBe(source);
    expect(characters(reasoning.mock.calls)).toBeLessThan(source.length * 2);
    expect(characters(final.mock.calls)).toBeLessThan(source.length * 2);
  },
);

it.each(["<think>hidden</think>Done.", "<final>Done.</final>"])(
  "bounds transform work for a late %s",
  (marker) => {
    const prefix = "<article>Array<string>: a < b.</article>\n".repeat(96);
    const source = prefix + marker;
    const stream = createAssistantVisibleStreamText();
    appendChunks(stream, prefix, 4);
    stream.append(marker);
    const processedCharacters = characters([...reasoning.mock.calls, ...final.mock.calls]);
    expect(stream.text).toBe(prefix + "Done.");
    expect(processedCharacters).toBeGreaterThan(0);
    expect(processedCharacters).toBeLessThan(source.length * 8);
  },
);

it("keeps marker probes and checkpoint deltas bounded after stripping a trace", () => {
  const line = "<article>Array<string>: a < b and c > d.</article>\n";
  const answer = line.repeat(256) + "Done.";
  const source = "tool call: hidden\n" + answer;
  const stream = createAssistantVisibleStreamText("final_answer");
  const comparisons = vi.spyOn(String.prototype, "startsWith");
  let comparedCharacters = 0;
  let delivered = "";
  try {
    // Complete lines isolate checkpoint/probe work from provisional XML tool-tag handling.
    for (const chunk of ["tool call: hidden\n", ...Array<string>(256).fill(line), "Done."]) {
      const result = stream.append(chunk);
      delivered = result.delta === null ? result.text : delivered + result.delta;
    }
    comparedCharacters = characters(comparisons.mock.calls);
  } finally {
    comparisons.mockRestore();
  }
  expect(stream.text).toBe(answer);
  expect(delivered).toBe(answer);
  expect(comparedCharacters).toBeGreaterThan(0);
  expect(comparedCharacters).toBeLessThan(source.length * 64);
  expect(characters([...reasoning.mock.calls, ...final.mock.calls])).toBeLessThan(
    source.length * 4,
  );
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
])("preserves every prefix and final output for %s", (source, expected = source) => {
  for (const size of [1, 3, 7]) {
    const stream = createAssistantVisibleStreamText();
    let prefix = "";
    for (let offset = 0; offset < source.length; offset += size) {
      const chunk = source.slice(offset, offset + size);
      const previous = stream.text;
      prefix += chunk;
      const result = stream.append(chunk);
      const visible = sanitizeAssistantVisibleStreamText(prefix);
      expect(result.text).toBe(visible);
      expect(result.delta === null ? result.text : previous + result.delta).toBe(visible);
    }
    expect(stream.text).toBe(expected ?? source);
  }
});

it.each([
  ["Before <final data-note='ok'>Answer</final> After", "Before Answer After"],
  ["< / FINAL >Answer", "Answer"],
  ["<final /bare>literal", "<final /bare>literal"],
  ["<final-result>literal</final-result>", "<final-result>literal</final-result>"],
])("preserves user-facing final marker behavior for %s", (source, expected) => {
  const stream = createTextProjection(userFacingTextFilters(false, true));
  let prefix = "";
  for (const char of source) {
    prefix += char;
    expect(stream.append(char).text).toBe(sanitizeUserFacingText(prefix, { streaming: true }));
  }
  expect(stream.text).toBe(expected);
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
        appendChunks(stream, prefix, 1);
      }
      appendChunks(stream, body, 4);
      expect(stream.text).toBe(prefix + body);
      expect(characters(inbound.mock.calls)).toBeLessThan((prefix.length + body.length) * 2);
    }
  },
);

it.each([
  "[Mon 2026-10-24 12:34 UTC] Visible answer",
  `${MESSAGE_TOOL_DELIVERY_HINTS[0]}\nVisible answer`,
  `[Mon 2026-10-24 12:34 ${"long timezone ".repeat(16)}] Visible answer`,
  "[docs](https://example.com)\nContext: ordinary prose",
  "\n\tContext: \t\r\n<active_memory_plugin>\nPrivate context\n</active_memory_plugin>\n\nVisible answer",
  'Conversation info: ⟦openclaw:ctx⟧\n```json\n{"id":"synthetic"}\n```\n\nVisible answer',
])("preserves canonical inbound filtering across every split: %s", (source) => {
  const inboundFilter = userFacingTextFilters(false, true).find(
    (filter) => filter.transform === inboundMetadata.stripInboundMetadata,
  );
  if (!inboundFilter) {
    throw new Error("Missing inbound metadata stage in the shipping text pipeline.");
  }
  const stream = createTextProjection([inboundFilter]);
  for (const initial of ["", source.slice(0, 7)]) {
    stream.replace(initial);
    let prefix = initial;
    for (const char of source.slice(initial.length)) {
      const previous = stream.text;
      prefix += char;
      const result = stream.append(char);
      const expected = inboundMetadata.stripInboundMetadata(prefix);
      expect(result.text, JSON.stringify(prefix)).toBe(expected);
      expect(result.delta === null ? result.text : previous + result.delta).toBe(expected);
    }
  }
  stream.replace("");
  expect(stream.append(source).text).toBe(inboundMetadata.stripInboundMetadata(source));
  stream.replace("[ordinary] Context: literal");
  expect(stream.append(" answer").text).toBe("[ordinary] Context: literal answer");
});
