/**
 * Phase 4 tests: model-visible structured tool result metadata injection.
 *
 * These tests verify:
 * - appendStructuredResultMetadata appends a correctly delimited JSON block
 * - extractStructuredResultFromText round-trips the envelope
 * - stripStructuredResultMetadata restores the original text
 * - All helpers are safe on edge inputs and never throw
 * - Backwards compat: text without metadata returns undefined / unchanged
 */

import { describe, expect, it } from "vitest";
import {
  OC_RESULT_META_CLOSE,
  OC_RESULT_META_OPEN,
  appendStructuredResultMetadata,
  extractStructuredResultFromText,
  stripStructuredResultMetadata,
} from "./agent-tool-result-model-output.js";
import { wrapToolError, wrapToolOk } from "./agent-tool-result.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const successEnvelope = wrapToolOk({
  summary: "file read successfully",
  data: null,
  sources: [],
});

const errorEnvelope = wrapToolError({
  code: "not_found",
  message: "File not found: /tmp/missing",
  retryable: false,
});

const temporaryError = wrapToolError({
  code: "temporary",
  message: "Connection timed out",
  retryable: true,
});

// ---------------------------------------------------------------------------
// appendStructuredResultMetadata
// ---------------------------------------------------------------------------

describe("appendStructuredResultMetadata — basic shape", () => {
  it("appends metadata block after original text", () => {
    const result = appendStructuredResultMetadata("hello world", successEnvelope);
    expect(result.startsWith("hello world\n")).toBe(true);
    expect(result).toContain(OC_RESULT_META_OPEN);
    expect(result).toContain(OC_RESULT_META_CLOSE);
  });

  it("includes compact JSON of the success envelope", () => {
    const result = appendStructuredResultMetadata("output", successEnvelope);
    const expected = JSON.stringify(successEnvelope);
    expect(result).toContain(expected);
  });

  it("includes compact JSON of the error envelope", () => {
    const result = appendStructuredResultMetadata("error text", errorEnvelope);
    const expected = JSON.stringify(errorEnvelope);
    expect(result).toContain(expected);
  });

  it("places open tag immediately after the separating newline", () => {
    const result = appendStructuredResultMetadata("text", successEnvelope);
    expect(result).toContain(`\n${OC_RESULT_META_OPEN}`);
  });

  it("ends with the close tag", () => {
    const result = appendStructuredResultMetadata("text", successEnvelope);
    expect(result.endsWith(OC_RESULT_META_CLOSE)).toBe(true);
  });

  it("preserves original text byte-for-byte before the separator", () => {
    const original = "line1\nline2\nline3";
    const result = appendStructuredResultMetadata(original, successEnvelope);
    expect(result.startsWith(original + "\n")).toBe(true);
  });

  it("works with empty original text", () => {
    const result = appendStructuredResultMetadata("", successEnvelope);
    expect(result).toBe(
      `\n${OC_RESULT_META_OPEN}${JSON.stringify(successEnvelope)}${OC_RESULT_META_CLOSE}`,
    );
  });

  it("works with multiline original text", () => {
    const text = "a\nb\nc";
    const result = appendStructuredResultMetadata(text, successEnvelope);
    expect(result.startsWith(text)).toBe(true);
    expect(result).toContain(OC_RESULT_META_OPEN);
  });

  it("works with very long original text (no truncation)", () => {
    const longText = "x".repeat(50_000);
    const result = appendStructuredResultMetadata(longText, successEnvelope);
    expect(result.startsWith(longText)).toBe(true);
    expect(result).toContain(OC_RESULT_META_OPEN);
  });

  it("works with a retryable temporary error envelope", () => {
    const result = appendStructuredResultMetadata("timed out", temporaryError);
    expect(result).toContain('"retryable":true');
    expect(result).toContain('"code":"temporary"');
  });

  it("never throws on any AgentToolResult input", () => {
    expect(() => appendStructuredResultMetadata("text", successEnvelope)).not.toThrow();
    expect(() => appendStructuredResultMetadata("text", errorEnvelope)).not.toThrow();
    expect(() => appendStructuredResultMetadata("", successEnvelope)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// extractStructuredResultFromText — round-trip
// ---------------------------------------------------------------------------

describe("extractStructuredResultFromText — round-trip", () => {
  it("recovers a success envelope from annotated text", () => {
    const annotated = appendStructuredResultMetadata("output", successEnvelope);
    const recovered = extractStructuredResultFromText(annotated);
    expect(recovered).toEqual(successEnvelope);
  });

  it("recovers an error envelope from annotated text", () => {
    const annotated = appendStructuredResultMetadata("error text", errorEnvelope);
    const recovered = extractStructuredResultFromText(annotated);
    expect(recovered).toEqual(errorEnvelope);
  });

  it("recovered ok=true envelope has correct shape", () => {
    const annotated = appendStructuredResultMetadata("done", successEnvelope);
    const recovered = extractStructuredResultFromText(annotated);
    if (!recovered || !recovered.ok) {
      throw new Error("expected ok=true");
    }
    expect(recovered.summary).toBe("file read successfully");
    expect(recovered.sources).toEqual([]);
  });

  it("recovered ok=false envelope has correct shape", () => {
    const annotated = appendStructuredResultMetadata("fail", errorEnvelope);
    const recovered = extractStructuredResultFromText(annotated);
    if (!recovered || recovered.ok) {
      throw new Error("expected ok=false");
    }
    expect(recovered.error.code).toBe("not_found");
    expect(recovered.error.retryable).toBe(false);
  });

  it("works when original text contains special characters", () => {
    const text = 'result: {"key":"val","arr":[1,2,3]}';
    const annotated = appendStructuredResultMetadata(text, successEnvelope);
    const recovered = extractStructuredResultFromText(annotated);
    expect(recovered).toEqual(successEnvelope);
  });
});

// ---------------------------------------------------------------------------
// extractStructuredResultFromText — backwards compat / safety
// ---------------------------------------------------------------------------

describe("extractStructuredResultFromText — backwards compat and safety", () => {
  it("returns undefined for plain text with no metadata block", () => {
    expect(extractStructuredResultFromText("just some output")).toBeUndefined();
  });

  it("returns undefined for empty string", () => {
    expect(extractStructuredResultFromText("")).toBeUndefined();
  });

  it("returns undefined when open tag is present but close tag is missing", () => {
    const malformed = `text\n${OC_RESULT_META_OPEN}{"ok":true,"summary":"x","data":null,"sources":[]}`;
    expect(extractStructuredResultFromText(malformed)).toBeUndefined();
  });

  it("returns undefined for malformed JSON inside tags", () => {
    const malformed = `text\n${OC_RESULT_META_OPEN}not-json${OC_RESULT_META_CLOSE}`;
    expect(extractStructuredResultFromText(malformed)).toBeUndefined();
  });

  it("returns undefined for valid JSON that is not an AgentToolResult (missing ok field)", () => {
    const notEnvelope = `text\n${OC_RESULT_META_OPEN}{"foo":"bar"}${OC_RESULT_META_CLOSE}`;
    expect(extractStructuredResultFromText(notEnvelope)).toBeUndefined();
  });

  it("never throws on any input", () => {
    expect(() => extractStructuredResultFromText("")).not.toThrow();
    expect(() => extractStructuredResultFromText("plain text")).not.toThrow();
    expect(() => extractStructuredResultFromText(`${OC_RESULT_META_OPEN}broken`)).not.toThrow();
    expect(() =>
      extractStructuredResultFromText(`${OC_RESULT_META_OPEN}${OC_RESULT_META_CLOSE}`),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// stripStructuredResultMetadata
// ---------------------------------------------------------------------------

describe("stripStructuredResultMetadata", () => {
  it("restores the original text after annotation", () => {
    const original = "hello world";
    const annotated = appendStructuredResultMetadata(original, successEnvelope);
    expect(stripStructuredResultMetadata(annotated)).toBe(original);
  });

  it("restores multiline original text", () => {
    const original = "line1\nline2\nline3";
    const annotated = appendStructuredResultMetadata(original, successEnvelope);
    expect(stripStructuredResultMetadata(annotated)).toBe(original);
  });

  it("returns text unchanged when no metadata block is present", () => {
    const plain = "plain output";
    expect(stripStructuredResultMetadata(plain)).toBe(plain);
  });

  it("returns empty string unchanged", () => {
    expect(stripStructuredResultMetadata("")).toBe("");
  });

  it("never throws on any input", () => {
    expect(() => stripStructuredResultMetadata("")).not.toThrow();
    expect(() => stripStructuredResultMetadata("no metadata")).not.toThrow();
    const annotated = appendStructuredResultMetadata("text", errorEnvelope);
    expect(() => stripStructuredResultMetadata(annotated)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Integration: verify wiring produces model-visible content
// ---------------------------------------------------------------------------

describe("Phase 4 integration — model-visible output shape", () => {
  it("annotated text starts with original output and ends with close tag", () => {
    const outputText = "tool ran successfully\nsome details here";
    const annotated = appendStructuredResultMetadata(outputText, successEnvelope);
    // Original text is preserved at the start.
    expect(annotated.startsWith(outputText)).toBe(true);
    // Close tag is at the very end.
    expect(annotated.endsWith(OC_RESULT_META_CLOSE)).toBe(true);
  });

  it("model receives both the output text and the structured summary", () => {
    const outputText = "read 42 bytes from file";
    const envelope = wrapToolOk({
      summary: "read 42 bytes from file",
      data: null,
      sources: ["/tmp/foo"],
    });
    const annotated = appendStructuredResultMetadata(outputText, envelope);
    // Model sees the original text.
    expect(annotated).toContain(outputText);
    // Model can parse the structured summary.
    const recovered = extractStructuredResultFromText(annotated);
    expect(recovered?.ok).toBe(true);
    if (recovered?.ok) {
      expect(recovered.summary).toBe("read 42 bytes from file");
      expect(recovered.sources).toEqual(["/tmp/foo"]);
    }
  });

  it("error case: model receives error code and retryability hint", () => {
    const outputText = "Error: connection refused";
    const envelope = wrapToolError({
      code: "temporary",
      message: "connection refused",
      retryable: true,
      next_hint: "retry after a short wait",
    });
    const annotated = appendStructuredResultMetadata(outputText, envelope);
    const recovered = extractStructuredResultFromText(annotated);
    expect(recovered?.ok).toBe(false);
    expect(recovered).toBeDefined();
    if (recovered && !recovered.ok) {
      expect(recovered.error.code).toBe("temporary");
      expect(recovered.error.retryable).toBe(true);
      expect(recovered.next_hint).toBe("retry after a short wait");
    }
  });

  it("discriminated union narrows correctly on recovered envelope", () => {
    const successAnnotated = appendStructuredResultMetadata("done", successEnvelope);
    const errorAnnotated = appendStructuredResultMetadata("fail", errorEnvelope);

    const r1 = extractStructuredResultFromText(successAnnotated);
    if (r1?.ok) {
      expect(typeof r1.summary).toBe("string");
    } else {
      throw new Error("expected ok=true");
    }

    const r2 = extractStructuredResultFromText(errorAnnotated);
    if (r2 && !r2.ok) {
      expect(typeof r2.error.code).toBe("string");
    } else {
      throw new Error("expected ok=false");
    }
  });
});
