import { afterAll, beforeEach, expect, it, vi } from "vitest";
import { RUNTIME_CONTEXT_HEADER } from "../../llm/types.js";
import { createTextProjection } from "../../shared/text/text-projection.js";
import {
  createAssistantVisibleStreamText,
  sanitizeAssistantVisibleStreamText,
} from "../embedded-agent-utils.js";
import * as runtimeContext from "../internal-runtime-context.js";
import { userFacingTextFilters } from "./sanitize-user-facing-text.js";

// Keep the spy for the whole module: filter arrays cache their transforms.
const scrub = vi.spyOn(runtimeContext, "stripInternalRuntimeContext");

// Block bodies: a hook that returns a value has it treated as a teardown callback.
beforeEach(() => {
  scrub.mockClear();
});
afterAll(() => {
  scrub.mockRestore();
});

function characters(calls: ReadonlyArray<readonly [string, ...unknown[]]>): number {
  return calls.reduce((sum, [text]) => sum + text.length, 0);
}

function appendChunks(
  stream: ReturnType<typeof createAssistantVisibleStreamText>,
  text: string,
  size: number,
  onChunk?: (visible: string, prefix: string) => void,
): string {
  let visible = stream.text;
  for (let offset = 0; offset < text.length; offset += size) {
    const result = stream.append(text.slice(offset, offset + size));
    visible = result.delta === null ? result.text : visible + result.delta;
    onChunk?.(visible, text.slice(0, offset + size));
  }
  return visible;
}

it.each([
  ["an empty", ""],
  ["a non-empty", "Earlier preview text.\n"],
] as const)(
  "does not scrub the whole reply for ordinary English streamed text after %s replacement",
  (_label, initial) => {
    // Any lowercase "o" used to activate the runtime-context filter through the header's
    // first character, turning every delta into a whole-reply scan. The subscriber also
    // starts each projection with replace(previousStream?.raw ?? "").
    const sentence =
      "The quick brown fox jumps over the lazy dog while the operator reviews one more log line. ";
    const source = sentence
      .repeat(Math.ceil(65_536 / sentence.length))
      .slice(0, 65_536)
      .trimEnd();
    const stream = createAssistantVisibleStreamText();
    stream.replace(initial);
    scrub.mockClear();

    expect(appendChunks(stream, source, 4)).toBe(initial + source);
    expect(characters(scrub.mock.calls)).toBe(0);
  },
);

it("still scrubs a complete runtime-context block", () => {
  const source = [
    "Visible intro.",
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "private runtime context",
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_END,
    "Visible outro.",
  ].join("\n");
  const stream = createAssistantVisibleStreamText();

  expect(appendChunks(stream, source, 3)).toBe("Visible intro.\n\nVisible outro.");
  expect(characters(scrub.mock.calls)).toBeGreaterThan(0);
});

it.each([1, 2, 3, 5, 7])("withholds every partial delimiter at %i-character deltas", (size) => {
  const secret = "private runtime context";
  const shapes = [
    ["column 0", "", "\n"],
    ["indented", "   ", "\n"],
    ["tab-indented", "\t", "\n"],
    ["CRLF", "  ", "\r\n"],
  ] as const;
  const delimiters = [
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN,
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_END,
    RUNTIME_CONTEXT_HEADER,
  ];

  for (const [shape, indent, newline] of shapes) {
    const source = [
      "Before.",
      `${indent}${runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN}`,
      secret,
      `${indent}${runtimeContext.INTERNAL_RUNTIME_CONTEXT_END}`,
      "After.",
    ].join(newline);
    const stream = createAssistantVisibleStreamText();
    let visible = "";

    for (let offset = 0; offset < source.length; offset += size) {
      const result = stream.append(source.slice(offset, offset + size));
      visible = result.delta === null ? result.text : visible + result.delta;
      // The private body must never reach the accumulated preview, and the current line
      // must never hold a delimiter prefix (including an indented one).
      expect(visible, shape).not.toContain(secret);
      const currentLine = visible.slice(visible.lastIndexOf("\n") + 1).trim();
      expect(
        currentLine === "" || !delimiters.some((delimiter) => delimiter.startsWith(currentLine)),
        `${shape} line=${JSON.stringify(currentLine)}`,
      ).toBe(true);
    }

    expect(visible, shape).toBe("Before.\n\nAfter.");
    expect(stream.text, shape).toBe("Before.\n\nAfter.");
  }
});

it.each([1, 2, 3, 5, 7])(
  "matches the canonical hold for indented delimiters at %i-character deltas",
  (size) => {
    const source = [
      "Intro.",
      `   ${runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN}`,
      "private runtime context",
      `   ${runtimeContext.INTERNAL_RUNTIME_CONTEXT_END}`,
      "Outro.",
    ].join("\n");
    // The runtime filter alone, so no upstream stage can mask a missing hold.
    const stream = createTextProjection(userFacingTextFilters(false, true));
    const normalize = (text: string) => text.replace(/[ \t\r\n]+$/u, "");

    for (let offset = 0; offset < source.length; offset += size) {
      stream.append(source.slice(offset, offset + size));
      const canonical = runtimeContext.stripInternalRuntimeContext(source.slice(0, offset + size), {
        streaming: true,
      });
      expect(normalize(stream.text)).toBe(normalize(canonical));
    }

    expect(stream.text).toBe("Intro.\n\nOutro.");
  },
);

it("keeps an unterminated block hidden after a replacement", () => {
  const stream = createAssistantVisibleStreamText();
  stream.replace(`${runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN}\nsecret`);

  expect(stream.text).toBe("");
  expect(stream.append(" body\n").text).toBe("");
  expect(stream.append(`${runtimeContext.INTERNAL_RUNTIME_CONTEXT_END}\nVisible`).text).toBe(
    "Visible",
  );
});

it.each([1, 3, 5, 7])(
  "keeps the whitespace-tolerant carrier contract at %i-character deltas",
  (size) => {
    // The canonical grammar accepts any whitespace between carrier words, so a reflowed
    // preface and notice must still be stripped instead of reaching the preview.
    const source = [
      "OpenClaw runtime",
      "event.",
      "This context is runtime-generated,",
      "not user-authored. Keep internal details private.",
      "",
      "Visible reply.",
    ].join("\n");
    const stream = createAssistantVisibleStreamText();
    const visible = appendChunks(stream, source, size, (chunkVisible, prefix) => {
      expect(chunkVisible).toBe(sanitizeAssistantVisibleStreamText(prefix));
    });

    expect(visible).toBe("Visible reply.");
    expect(stream.text).toBe("Visible reply.");
  },
);

it.each([1, 3, 7])("keeps a carrier reflowed across 257 spaces at %i-character deltas", (size) => {
  // Whitespace runs of arbitrary width are valid in the canonical carrier grammar (`\s+`), and
  // that class includes Unicode spaces: the probe must collapse them instead of letting its
  // bounded window drop the carrier prefix.
  for (const pad of [" ", "\u00A0"]) {
    const spaces = pad.repeat(257);
    const source = [
      `OpenClaw${spaces}runtime event.`,
      `This${spaces}context is runtime-generated, not user-authored. Keep internal details private.`,
      "",
      "Visible reply.",
    ].join("\n");
    const stream = createAssistantVisibleStreamText();
    const visible = appendChunks(stream, source, size, (chunkVisible, prefix) => {
      expect(chunkVisible, JSON.stringify(pad)).toBe(sanitizeAssistantVisibleStreamText(prefix));
    });

    expect(visible, JSON.stringify(pad)).toBe("Visible reply.");
    expect(stream.text, JSON.stringify(pad)).toBe("Visible reply.");
  }
});

it("scrubs a private block that opens a coalesced delta larger than the probe tail", () => {
  // Provider deltas have no size limit: the trigger must inspect the whole incoming chunk, not
  // only the retained overlap, or the block body is published without ever activating.
  const stream = createAssistantVisibleStreamText();
  stream.replace("");

  expect(
    stream.append(`${runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN}\n${"secret ".repeat(20)}`).text,
  ).toBe("");
  expect(stream.text).toBe("");
  expect(stream.append(`\n${runtimeContext.INTERNAL_RUNTIME_CONTEXT_END}\nVisible`).text).toBe(
    "Visible",
  );
});

it("scrubs a complete private block inside one coalesced delta", () => {
  const stream = createAssistantVisibleStreamText();
  stream.replace("");
  const block = [
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_BEGIN,
    "private runtime context",
    runtimeContext.INTERNAL_RUNTIME_CONTEXT_END,
    "Visible reply.",
  ].join("\n");

  expect(stream.append(block).text).toBe("Visible reply.");
});
