// Msteams tests cover mixed-case HTML attachment content-type handling.
import { describe, expect, it } from "vitest";
import { extractTextFromHtmlAttachments } from "./message-handler.js";

describe("extractTextFromHtmlAttachments mixed-case content type", () => {
  // MIME types are case-insensitive (RFC 2045); a relay payload may emit
  // "TEXT/HTML" and the message handler must still extract its body text.
  it("extracts text from a mixed-case TEXT/HTML attachment", () => {
    const result = extractTextFromHtmlAttachments([
      { contentType: "TEXT/HTML", content: "<p>Hello Teams</p>" },
    ]);
    expect(result).toBe("Hello Teams");
  });

  it("extracts text from a lowercase text/html attachment (regression)", () => {
    const result = extractTextFromHtmlAttachments([
      { contentType: "text/html", content: "<p>Hello Teams</p>" },
    ]);
    expect(result).toBe("Hello Teams");
  });

  it("returns empty when no HTML attachment is present", () => {
    const result = extractTextFromHtmlAttachments([
      { contentType: "application/vnd.microsoft.card.hero", content: {} },
    ]);
    expect(result).toBe("");
  });

  it("extracts from the first HTML attachment with usable text", () => {
    const result = extractTextFromHtmlAttachments([
      { contentType: "Text/Html", content: "<p>First</p>" },
      { contentType: "text/html", content: "<p>Second</p>" },
    ]);
    expect(result).toBe("First");
  });

  it("extracts body text from an attachment with a { text } content object", () => {
    const result = extractTextFromHtmlAttachments([
      { contentType: "TEXT/HTML", content: { text: "<p>Object body</p>" } },
    ]);
    expect(result).toBe("Object body");
  });
});
