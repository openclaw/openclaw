import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
import { truncateCodexCatalogPreview } from "./session-catalog-parsing.js";

describe("truncateCodexCatalogPreview", () => {
  it("preserves unpaired surrogate code units while detaching the preview", () => {
    for (const input of ["\ud800", "\udc00", "prefix\ud800suffix"]) {
      expect(truncateCodexCatalogPreview(input, sanitizeTerminalText)).toBe(input);
    }
  });

  it("preserves valid text, surrogate pairs, and truncation behavior", () => {
    expect(truncateCodexCatalogPreview("plain preview", sanitizeTerminalText)).toBe(
      "plain preview",
    );
    expect(truncateCodexCatalogPreview("emoji \u{1f600}", sanitizeTerminalText)).toBe(
      "emoji \u{1f600}",
    );
    const long = "a".repeat(600);
    const truncated = truncateCodexCatalogPreview(long, sanitizeTerminalText);
    expect(truncated).toHaveLength(500);
    expect(truncated).toBe("a".repeat(500));
  });
});
