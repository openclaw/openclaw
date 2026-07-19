import { describe, expect, it } from "vitest";
import {
  PAGE_SHARE_MAX_CONTENT_CHARS,
  PAGE_SHARE_MAX_NOTE_CHARS,
  PAGE_SHARE_MAX_TITLE_CHARS,
  PAGE_SHARE_MAX_URL_CHARS,
  buildPageSharePayload,
  capturePageContent,
  googleDocIdFromUrl,
  truncateShareText,
} from "./page-share-core.js";

describe("page share core", () => {
  it("extracts Google document ids from document URLs only", () => {
    expect(
      googleDocIdFromUrl("https://docs.google.com/document/d/document-id_123/edit?tab=t.0"),
    ).toBe("document-id_123");
    expect(googleDocIdFromUrl("https://docs.google.com/spreadsheets/d/sheet-id/edit")).toBeNull();
    expect(googleDocIdFromUrl("https://example.com/document/d/not-google/edit")).toBeNull();
    expect(googleDocIdFromUrl("not a URL")).toBeNull();
  });

  it("keeps text at the boundary and marks truncation beyond it", () => {
    expect(truncateShareText("12345", 5)).toBe("12345");
    expect(truncateShareText("123456", 5)).toBe("12345\n\n[Truncated: original was 6 characters]");
  });

  it("trims fields, preserves newlines, applies caps, and drops empty optionals", () => {
    const payload = buildPageSharePayload({
      url: ` https://example.com/${"u".repeat(PAGE_SHARE_MAX_URL_CHARS)} `,
      title: ` ${"t".repeat(PAGE_SHARE_MAX_TITLE_CHARS + 10)} `,
      content: `  first   line  \n second\tline ${"c".repeat(PAGE_SHARE_MAX_CONTENT_CHARS)} `,
      selection: "   ",
      note: ` ${"n".repeat(PAGE_SHARE_MAX_NOTE_CHARS + 10)} `,
    });

    expect(payload.url).toHaveLength(PAGE_SHARE_MAX_URL_CHARS);
    expect(payload.title).toHaveLength(PAGE_SHARE_MAX_TITLE_CHARS);
    expect(payload.content).toContain("first line \n second line");
    expect(payload.content).toContain("[Truncated: original was");
    expect(payload.note).toHaveLength(PAGE_SHARE_MAX_NOTE_CHARS);
    expect(payload).not.toHaveProperty("selection");
  });

  it("keeps the injected capture function self-contained", () => {
    const source = String(capturePageContent);
    expect(source).not.toMatch(/\b(?:import|require)\b/u);
  });
});
