import { describe, expect, it } from "vitest";
import { buildMinutesDocx, type BuildMinutesDocxInput } from "./meeting-minutes-docx.js";

/**
 * Entries are STORE'd (uncompressed), so the whole archive decodes to text containing each part
 * verbatim — no zip dependency needed to verify content (the original jszip read was dropped so the
 * plugin adds nothing to the dependency graph).
 */
async function docxText(input: BuildMinutesDocxInput): Promise<{ buffer: Buffer; text: string }> {
  const buffer = await buildMinutesDocx(input);
  return { buffer, text: buffer.toString("utf8") };
}

describe("buildMinutesDocx", () => {
  it("returns a ZIP-magic buffer containing the four .docx parts", async () => {
    const { buffer, text } = await docxText({
      title: "Meeting minutes",
      subtitle: "Call with Sara — ~5 min, 2 human participant(s).",
      transcript: [{ role: "user", text: "Sara: let's ship friday" }],
    });
    expect(Buffer.isBuffer(buffer)).toBe(true);
    // ZIP local file header magic "PK\x03\x04".
    expect(buffer.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
    for (const part of [
      "[Content_Types].xml",
      "_rels/.rels",
      "word/document.xml",
      "word/_rels/document.xml.rels",
    ]) {
      expect(text).toContain(part);
    }
  });

  it("renders a speaker-prefixed turn attributed in the document XML", async () => {
    const { text } = await docxText({
      title: "Meeting minutes",
      transcript: [
        { role: "user", text: "Sara: we should raise the budget" },
        { role: "assistant", text: "Noted." },
        { role: "user", text: "no name here" },
      ],
    });
    // The exact speaker attribution is preserved verbatim from the prefixed turn.
    expect(text).toContain("Sara: we should raise the budget");
    // Assistant turns are labelled; un-prefixed caller turns fall back to the generic label.
    expect(text).toContain("Assistant: Noted.");
    expect(text).toContain("Caller: no name here");
  });

  it("renders headed sections with bullets and skips empty ones", async () => {
    const { text } = await docxText({
      title: "Meeting minutes",
      sections: [
        { heading: "Key points", items: ["budget is on track"] },
        { heading: "Decisions", items: [] },
      ],
      transcript: [],
    });
    expect(text).toContain("Key points");
    expect(text).toContain("budget is on track");
    // An empty section produces no heading.
    expect(text).not.toContain("Decisions");
  });

  it("XML-escapes special characters", async () => {
    const { text } = await docxText({
      title: "Minutes <&>",
      transcript: [{ role: "user", text: 'Sara: a & b < c > d "e"' }],
    });
    expect(text).toContain("Minutes &lt;&amp;&gt;");
    expect(text).toContain("a &amp; b &lt; c &gt; d &quot;e&quot;");
    expect(text).not.toContain("a & b");
  });
});
