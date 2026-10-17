import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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
beforeEach(() => {
  reasoning.mockClear();
  final.mockClear();
});
afterAll(() => {
  reasoning.mockRestore();
  final.mockRestore();
});

it.each([undefined, "final_answer"] as const)(
  "bounds reasoning and final transform input for ordinary streamed markup (%s)",
  (phase) => {
    const source = "<article>Array<string>: a < b and c > d.</article>\n".repeat(96) + "Done.";
    const stream = createAssistantVisibleStreamText(phase);
    for (let offset = 0; offset < source.length; offset += 4) {
      stream.append(source.slice(offset, offset + 4));
    }
    const reasoningCharacters = reasoning.mock.calls.reduce((sum, [text]) => sum + text.length, 0);
    const finalCharacters = final.mock.calls.reduce((sum, [text]) => sum + text.length, 0);
    expect(stream.text).toBe(source);
    expect(reasoningCharacters).toBeLessThan(source.length * 2);
    expect(finalCharacters).toBeLessThan(source.length * 2);
  },
);

it.each([
  ["reasoning", "<think>hidden</think>Done."],
  ["final", "<final>Done.</final>"],
])("bounds transform input when a %s tag arrives in the final delta", (_name, marker) => {
  const prefix = "<article>Array<string>: a < b.</article>\n".repeat(96);
  const source = prefix + marker;
  const stream = createAssistantVisibleStreamText();
  for (let offset = 0; offset < prefix.length; offset += 4) {
    stream.append(prefix.slice(offset, offset + 4));
  }
  stream.append(marker);
  const processedCharacters = [...reasoning.mock.calls, ...final.mock.calls].reduce(
    (sum, [text]) => sum + text.length,
    0,
  );
  expect(stream.text).toBe(prefix + "Done.");
  expect(processedCharacters).toBeGreaterThan(0);
  expect(processedCharacters).toBeLessThan(source.length * 8);
});

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
    comparedCharacters = comparisons.mock.calls.reduce((sum, [text]) => sum + text.length, 0);
  } finally {
    comparisons.mockRestore();
  }
  const processedCharacters = [...reasoning.mock.calls, ...final.mock.calls].reduce(
    (sum, [text]) => sum + text.length,
    0,
  );
  expect(stream.text).toBe(answer);
  expect(delivered).toBe(answer);
  expect(comparedCharacters).toBeGreaterThan(0);
  expect(comparedCharacters).toBeLessThan(source.length * 64);
  expect(processedCharacters).toBeLessThan(source.length * 4);
});

describe("streamed marker projection", () => {
  it.each([
    [
      "ordinary markup",
      "<div>Array<string>: a < b and c > d.</div>",
      "<div>Array<string>: a < b and c > d.</div>",
    ],
    [
      "lookalike names",
      "<thinking-about>literal</thinking-about><finalizing>literal</finalizing>",
      "<thinking-about>literal</thinking-about><finalizing>literal</finalizing>",
    ],
    ["spaced provider tags", "< \u00a0AnTmL:ThiNking >secret< / antml:thinking >Answer", "Answer"],
    ["another provider", "<mm:thought>secret</mm:thought>Answer", "Answer"],
    ["private tags", "<internal>secret</internal>Answer", "Answer"],
    ["quoted reasoning attributes", '<think note="a>b">secret</think>Answer', "Answer"],
    [
      "malformed quotes around nested private tags",
      '<thinking x="<internal>private reflection</internal>',
      '<thinking x="',
    ],
    ["late final tags", "<div>Visible</div><final> Tail</final>", "<div>Visible</div> Tail"],
    ["malformed final attributes", '<final reason="a>b">visible', '<final reason="a>b">visible'],
    [
      "code-owned tags",
      "```xml\n<think>literal</think>\n<final>literal</final>\n```\nDone.",
      "```xml\n<think>literal</think>\n<final>literal</final>\n```\nDone.",
    ],
    ["unbounded head spacing", `<${" ".repeat(128)}/${"\t".repeat(128)}ThiNKing>Answer`, "Answer"],
  ])("preserves every prefix and final output for %s", (_name, source, expected) => {
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
      expect(stream.text).toBe(expected);
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
    "restarts marker probing after an upstream replacement with %s",
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
    expect(stream.append("<div>First</div>").text).toBe("<div>First</div>");
    expect(stream.replace("<thi").text).toBe("<thi");
    expect(stream.append("nk>secret</think>Answer").text).toBe("Answer");
    expect(stream.replace("<finalizing>literal</finalizing>").text).toBe(
      "<finalizing>literal</finalizing>",
    );
    expect(stream.append("<final>Tail</final>").text).toBe("<finalizing>literal</finalizing>Tail");
    expect(stream.replace("").text).toBe("");
    expect(stream.append("< / final >Fresh").text).toBe("Fresh");
  });
});
