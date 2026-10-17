import { sanitizeTerminalText } from "openclaw/plugin-sdk/text-chunking";
import { describe, expect, it } from "vitest";
import { truncateCodexCatalogPreview } from "./session-catalog-parsing.js";

describe("truncateCodexCatalogPreview", () => {
  it("preserves unpaired surrogate code units while detaching the preview", () => {
    for (const input of ["\ud800", "\udc00", "prefix\ud800suffix"]) {
      expect(truncateCodexCatalogPreview(input, sanitizeTerminalText)).toBe(input);
    }
  });
});
