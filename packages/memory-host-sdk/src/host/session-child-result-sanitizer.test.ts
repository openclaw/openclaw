import { describe, expect, it } from "vitest";
import { chunkMarkdown } from "./internal.js";
import { sanitizeChildResultTextForMemory } from "./session-child-result-sanitizer.js";
import { extractSessionText } from "./session-files.js";

const BEGIN = "<<<BEGIN_UNTRUSTED_CHILD_RESULT>>>";
const END = "<<<END_UNTRUSTED_CHILD_RESULT>>>";
const PLACEHOLDER = "[OpenClaw sanitized child result:";

function expectSanitized(output: string, needles: string[]): void {
  expect(output).toContain(PLACEHOLDER);
  expect(output).toContain("sha256=");
  expect(output).toContain("bytes=");
  for (const needle of needles) {
    expect(output).not.toContain(needle);
  }
  expect(sanitizeChildResultTextForMemory(output)).toBe(output);
}

describe("memory child result sanitizer", () => {
  it("redacts marked child results before memory extraction", () => {
    const rawNeedle = "MEMORY_SESSION_SECRET_LINE";
    const output = sanitizeChildResultTextForMemory(`${BEGIN}\n${rawNeedle}\n${END}`);
    expectSanitized(output, [rawNeedle]);
  });

  it("redacts bare child result marker tokens before memory extraction", () => {
    const rawNeedle = "BARE_MEMORY_CHILD_RESULT_SECRET";
    const output = sanitizeChildResultTextForMemory(
      `BEGIN_UNTRUSTED_CHILD_RESULT
${rawNeedle}
END_UNTRUSTED_CHILD_RESULT`,
    );

    expect(output).toContain("[OpenClaw sanitized child result:");
    expect(output).toContain("sha256=");
    expect(output).toContain("bytes=");
    expect(output).not.toContain(rawNeedle);
  });

  it("redacts transcript session text before export/indexing", () => {
    const rawNeedle = "MEMORY_TRANSCRIPT_SECRET_LINE";
    const output = extractSessionText(`${BEGIN}\n${rawNeedle}\n${END}`, "assistant");
    expect(output).toBeTruthy();
    expectSanitized(output ?? "", [rawNeedle]);
  });

  it("redacts chunk content before embedding chunks are built", () => {
    const rawNeedle = "MEMORY_CHUNK_SECRET_LINE";
    const chunks = chunkMarkdown(`heading\n${BEGIN}\n${rawNeedle}\n${END}`, {
      tokens: 200,
      overlap: 0,
    });
    const joined = chunks.map((chunk) => chunk.text).join("\n");
    expectSanitized(joined, [rawNeedle]);
  });

  it("preserves ordinary memory text", () => {
    const input = "A normal note mentioning diff --git as plain prose.";
    expect(sanitizeChildResultTextForMemory(input)).toBe(input);
  });
});
