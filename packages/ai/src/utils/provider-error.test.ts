import { describe, expect, it } from "vitest";
import { formatProviderError } from "./provider-error.js";

describe("formatProviderError", () => {
  it.each([
    {
      name: "JSON body",
      error: Object.assign(new Error("403 status code (no body)"), {
        status: 403,
        error: { message: "blocked by gateway" },
      }),
      expected: '403: {"message":"blocked by gateway"}',
    },
    {
      name: "text body",
      error: Object.assign(new Error("502 status code (no body)"), {
        status: 502,
        body: "proxy unavailable",
      }),
      expected: "502: proxy unavailable",
    },
    {
      name: "no body",
      error: Object.assign(new Error("503 status code (no body)"), { status: 503 }),
      expected: "503 status code (no body)",
    },
  ])("formats an HTTP error with $name", ({ error, expected }) => {
    expect(formatProviderError(error)).toBe(expected);
  });

  it("truncates long error bodies without splitting UTF-16 surrogate pairs", () => {
    const maxBody = 4_000;
    // Emoji fits entirely within the limit when it ends at the boundary.
    const body = `${"x".repeat(maxBody - 2)}😀tail`;
    const error = Object.assign(new Error("413 status code (no body)"), {
      status: 413,
      body,
    });

    expect(formatProviderError(error)).toBe(`413: ${"x".repeat(maxBody - 2)}😀... [truncated]`);
  });

  it("drops an emoji from the truncation boundary instead of splitting it", () => {
    const maxBody = 4_000;
    // Emoji starts at index maxBody-1. Truncating at maxBody would split it,
    // so the safe helper drops the entire emoji from the truncated result.
    const body = `${"x".repeat(maxBody - 1)}😀tail`;
    const error = Object.assign(new Error("413 status code (no body)"), {
      status: 413,
      body,
    });

    const result = formatProviderError(error);
    expect(result).toBe(`413: ${"x".repeat(maxBody - 1)}... [truncated]`);
    // Confirm no unpaired surrogate in the output.
    expect(result).not.toMatch(/[\u{D800}-\u{DFFF}]/u);
  });

  it("preserves an SDK message that already contains the response body", () => {
    const body = '{"error":{"message":"permission denied"}}';
    const error = Object.assign(new Error(body), { status: 403, body });

    expect(formatProviderError(error)).toBe(body);
  });
});
