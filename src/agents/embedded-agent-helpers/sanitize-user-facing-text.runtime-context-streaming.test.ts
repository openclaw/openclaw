import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { RUNTIME_CONTEXT_HEADER } from "../../llm/types.js";
import { streamChunks } from "../../shared/text/streaming.test-support.js";
import { createTextProjection } from "../../shared/text/text-projection.js";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../embedded-agent-utils.js";
import * as runtimeContext from "../internal-runtime-context.js";
import { userFacingTextFilters } from "./sanitize-user-facing-text.js";

// Keep the spy for the whole module: filter arrays cache their transforms.
const scrub = vi.spyOn(runtimeContext, "stripInternalRuntimeContext");
const begin = runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN;
const end = runtimeContext.INTERNAL_RUNTIME_CONTEXT_END;
const secret = "private runtime context";
const delimiters = [begin, end, RUNTIME_CONTEXT_HEADER];

beforeEach(() => void scrub.mockClear());
afterAll(() => scrub.mockRestore());

function privateBlock(before: string, after: string, indent = "", newline = "\n"): string {
  return [before, indent + begin, secret, indent + end, after].filter(Boolean).join(newline);
}

function expectCanonicalStream(source: string, size: number, label?: string): void {
  const stream = createAssistantVisibleStreamText();
  const result = streamChunks(source, size, stream, (chunk, offset) => {
    expect(chunk.text, label).toBe(sanitizeAssistantVisibleStreamText(source.slice(0, offset)));
  });
  expect([result.delivered, result.text], label).toEqual(["Visible reply.", "Visible reply."]);
}

it.each([
  ["an empty", ""],
  ["a non-empty", "Earlier preview text.\n"],
] as const)(
  "does not scrub the whole reply for ordinary English streamed text after %s replacement",
  (_label, initial) => {
    // Regression: an ordinary "o" activated whole-reply scans after subscriber replacement.
    const sentence =
      "The quick brown fox jumps over the lazy dog while the operator reviews one more log line. ";
    const source = sentence
      .repeat(Math.ceil(65_536 / sentence.length))
      .slice(0, 65_536)
      .trimEnd();
    const stream = createAssistantVisibleStreamText();
    stream.replace(initial);
    const prefix = stream.text;
    scrub.mockClear();

    expect(prefix + streamChunks(source, 4, stream).delivered).toBe(initial + source);
    expect(scrub.mock.calls.reduce((sum, [text]) => sum + text.length, 0)).toBe(0);
  },
);

it.each([1, 2, 3, 5, 7])("withholds every partial delimiter at %i-character deltas", (size) => {
  const shapes = [
    ["column 0", "", "\n"],
    ["indented", "   ", "\n"],
    ["tab-indented", "\t", "\n"],
    ["CRLF", "  ", "\r\n"],
  ] as const;
  for (const [shape, indent, newline] of shapes) {
    const source = privateBlock("Before.", "After.", indent, newline);
    const stream = createAssistantVisibleStreamText();
    const result = streamChunks(source, size, stream, ({ text: preview }) => {
      expect(preview, shape).not.toContain(secret);
      const currentLine = preview.slice(preview.lastIndexOf("\n") + 1).trim();
      expect(
        currentLine === "" || !delimiters.some((delimiter) => delimiter.startsWith(currentLine)),
        `${shape} line=${JSON.stringify(currentLine)}`,
      ).toBe(true);
    });
    expect([result.delivered, result.text], shape).toEqual([
      "Before.\n\nAfter.",
      "Before.\n\nAfter.",
    ]);
  }
  expect(scrub.mock.calls.reduce((sum, [text]) => sum + text.length, 0)).toBeGreaterThan(0);
});

it.each([1, 2, 3, 5, 7])(
  "matches the canonical hold for indented delimiters at %i-character deltas",
  (size) => {
    const source = privateBlock("Intro.", "Outro.", "   ");
    // The runtime filter alone, so no upstream stage can mask a missing hold.
    const stream = createTextProjection(userFacingTextFilters(false, true));
    const normalize = (text: string) => text.replace(/[ \t\r\n]+$/u, "");

    streamChunks(source, size, stream, (result, offset) => {
      const canonical = runtimeContext.stripInternalRuntimeContext(source.slice(0, offset), {
        streaming: true,
      });
      expect(normalize(result.text)).toBe(normalize(canonical));
    });

    expect(stream.text).toBe("Intro.\n\nOutro.");
  },
);

it("keeps an unterminated block hidden after a replacement", () => {
  const stream = createAssistantVisibleStreamText();
  stream.replace(`${begin}\nsecret`);

  expect([stream.text, stream.append(" body\n").text]).toEqual(["", ""]);
  expect(stream.append(`${end}\nVisible`).text).toBe("Visible");
});

it.each([1, 3, 5, 7])(
  "keeps the whitespace-tolerant carrier contract at %i-character deltas",
  (size) => {
    const source = [
      "OpenClaw runtime",
      "event.",
      "This context is runtime-generated,",
      "not user-authored. Keep internal details private.",
      "",
      "Visible reply.",
    ].join("\n");
    expectCanonicalStream(source, size);
  },
);

it.each([1, 3, 7])("keeps a carrier reflowed across 257 spaces at %i-character deltas", (size) => {
  // Long Unicode whitespace must not evict the carrier prefix from the bounded probe.
  for (const pad of [" ", "\u00A0"]) {
    const spaces = pad.repeat(257);
    const source = [
      `OpenClaw${spaces}runtime event.`,
      `This${spaces}context is runtime-generated, not user-authored. Keep internal details private.`,
      "",
      "Visible reply.",
    ].join("\n");
    expectCanonicalStream(source, size, JSON.stringify(pad));
  }
});

it("scrubs a private block that opens a coalesced delta larger than the probe tail", () => {
  // Inspect the whole incoming chunk, not only the retained probe tail.
  const stream = createAssistantVisibleStreamText();
  stream.replace("");

  expect(stream.append(`${begin}\n${"secret ".repeat(20)}`).text).toBe("");
  expect(stream.text).toBe("");
  expect(stream.append(`\n${end}\nVisible`).text).toBe("Visible");
});

it("scrubs a complete private block inside one coalesced delta", () => {
  const stream = createAssistantVisibleStreamText();
  stream.replace("");
  expect(stream.append(privateBlock("", "Visible reply.")).text).toBe("Visible reply.");
});
