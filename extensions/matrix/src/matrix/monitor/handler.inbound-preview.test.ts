import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
// Regression: the matrix inbound verbose preview must not split a UTF-16
// surrogate pair at the 200-code-unit boundary. Before the fix the handler
// used bodyText.slice(0, 200), which emits a lone surrogate when an emoji or
// other supplementary-plane character straddles position 200.
import { describe, expect, it } from "vitest";

// A string containing a lone surrogate throws when passed to encodeURIComponent,
// which is a runtime-safe well-formedness check that does not need ES2024 lib.
function isWellFormed(value: string): boolean {
  try {
    encodeURIComponent(value);
    return true;
  } catch {
    return false;
  }
}

describe("matrix inbound verbose preview truncation", () => {
  // Same limit used in handler.ts for the inbound preview. 😀 = \uD83D\uDE00;
  // placing it after 199 'x' chars makes the 200th code unit a high surrogate.
  const PREVIEW_LIMIT = 200;
  const highSurrogate = "\uD83D";
  const lowSurrogate = "\uDE00";
  const body = `${"x".repeat(199)}${highSurrogate}${lowSurrogate} tail`;

  it("keeps the preview well-formed when an emoji straddles the boundary", () => {
    const preview = truncateUtf16Safe(body, PREVIEW_LIMIT).replace(/\n/g, "\\n");
    expect(isWellFormed(preview)).toBe(true);
    // Naive slice would split the pair and end with the lone high surrogate.
    expect(preview.endsWith(highSurrogate)).toBe(false);
  });

  it("reproduces the old slice bug splitting the pair", () => {
    const buggy = body.slice(0, PREVIEW_LIMIT);
    // Documents why the helper is needed: the unguarded slice is malformed.
    expect(isWellFormed(buggy)).toBe(false);
  });

  it("still truncates plain ASCII input to the limit", () => {
    const preview = truncateUtf16Safe("a".repeat(250), PREVIEW_LIMIT);
    expect(preview.length).toBe(PREVIEW_LIMIT);
  });

  it("leaves short input unchanged", () => {
    const short = `hello ${highSurrogate}${lowSurrogate}`;
    expect(truncateUtf16Safe(short, PREVIEW_LIMIT)).toBe(short);
  });
});
