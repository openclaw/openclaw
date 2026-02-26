import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { IssueRecord } from "../types.js";
import { patchDocxWithTrackChanges } from "./docx-patcher.js";

async function makeDocx(documentXml: string): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );
  zip.file("word/document.xml", documentXml);
  return await zip.generateAsync({ type: "nodebuffer" });
}

async function readDocumentXml(docx: Buffer): Promise<string> {
  const zip = await JSZip.loadAsync(docx);
  const file = zip.file("word/document.xml");
  if (!file) {
    throw new Error("missing document.xml");
  }
  return await file.async("string");
}

function issue(overrides: Partial<IssueRecord>): IssueRecord {
  return {
    issueId: "ISS-001",
    article: "1",
    clause: "",
    category: "GRAMMAR",
    arabicExcerpt: "ع",
    englishExcerpt: "world",
    correction: "earth",
    severity: "LOW",
    notes: "",
    apply: true,
    ...overrides,
  };
}

describe("docx-patcher", () => {
  it("injects <w:del> + <w:ins> for a single-run correction", async () => {
    const docx = await makeDocx(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:body></w:document>`,
    );

    const result = await patchDocxWithTrackChanges(docx, [issue({ englishExcerpt: "world" })], {
      author: "Tester",
      date: "2026-02-25T00:00:00Z",
    });

    const xml = await readDocumentXml(result.output);
    expect(result.applied).toBe(1);
    expect(result.failed).toEqual([]);
    expect(xml).toContain("<w:del");
    expect(xml).toContain("<w:ins");
    expect(xml).toContain('<w:delText xml:space="preserve">world</w:delText>');
    expect(xml).toContain('<w:t xml:space="preserve">earth</w:t>');
  });

  it("handles correction spanning run boundaries while preserving surrounding text", async () => {
    const docx = await makeDocx(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello </w:t></w:r><w:r><w:t>world</w:t></w:r></w:p></w:body></w:document>`,
    );

    const result = await patchDocxWithTrackChanges(
      docx,
      [issue({ englishExcerpt: "lo wo", correction: "XX" })],
      {
        author: "Tester",
        date: "2026-02-25T00:00:00Z",
      },
    );

    const xml = await readDocumentXml(result.output);
    expect(result.applied).toBe(1);
    expect(xml).toContain("Hel");
    expect(xml).toContain("rld");
    expect(xml).toContain('<w:delText xml:space="preserve">lo wo</w:delText>');
    expect(xml).toContain('<w:t xml:space="preserve">XX</w:t>');
  });

  it("preserves pre-existing track changes and allocates higher unique ids", async () => {
    const docx = await makeDocx(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>
  <w:del w:id="7" w:author="Old" w:date="2020-01-01T00:00:00Z"><w:r><w:delText xml:space="preserve">old</w:delText></w:r></w:del>
  <w:ins w:id="8" w:author="Old" w:date="2020-01-01T00:00:00Z"><w:r><w:t xml:space="preserve">new</w:t></w:r></w:ins>
  <w:r><w:t>Hello world</w:t></w:r>
</w:p></w:body></w:document>`,
    );

    const result = await patchDocxWithTrackChanges(
      docx,
      [issue({ englishExcerpt: "world", correction: "earth" })],
      {
        author: "Tester",
        date: "2026-02-25T00:00:00Z",
      },
    );

    const xml = await readDocumentXml(result.output);
    expect(xml).toContain('w:id="7"');
    expect(xml).toContain('w:id="8"');
    expect(xml).toContain('w:id="9"');
    expect(xml).toContain('w:id="10"');
  });

  it("records failure and leaves document unpatched when target is missing", async () => {
    const docx = await makeDocx(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello world</w:t></w:r></w:p></w:body></w:document>`,
    );

    const result = await patchDocxWithTrackChanges(docx, [issue({ englishExcerpt: "missing" })], {
      author: "Tester",
      date: "2026-02-25T00:00:00Z",
    });

    const xml = await readDocumentXml(result.output);
    expect(result.applied).toBe(0);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.issueId).toBe("ISS-001");
    expect(xml).not.toContain("<w:del");
    expect(xml).not.toContain("<w:ins");
  });

  it("prefers article-scoped match when same excerpt appears in multiple articles", async () => {
    const docx = await makeDocx(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>
  <w:r><w:t>Article 1 Alpha target text.</w:t></w:r>
  <w:r><w:t> Article 2 Beta target text.</w:t></w:r>
</w:p></w:body></w:document>`,
    );

    const result = await patchDocxWithTrackChanges(
      docx,
      [
        issue({
          issueId: "ISS-002",
          article: "2",
          englishExcerpt: "target text",
          correction: "replaced",
        }),
      ],
      {
        author: "Tester",
        date: "2026-02-25T00:00:00Z",
      },
    );

    const xml = await readDocumentXml(result.output);
    expect(result.applied).toBe(1);
    const article2Idx = xml.indexOf("Article 2 Beta");
    const replacementIdx = xml.indexOf("replaced");
    expect(article2Idx).toBeGreaterThanOrEqual(0);
    expect(replacementIdx).toBeGreaterThan(article2Idx);
  });

  it("ensures all generated w:id values are unique", async () => {
    const docx = await makeDocx(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>
  <w:r><w:t>Hello world and moon</w:t></w:r>
</w:p></w:body></w:document>`,
    );

    const result = await patchDocxWithTrackChanges(
      docx,
      [
        issue({ issueId: "ISS-001", englishExcerpt: "world", correction: "earth" }),
        issue({ issueId: "ISS-002", englishExcerpt: "moon", correction: "mars" }),
      ],
      {
        author: "Tester",
        date: "2026-02-25T00:00:00Z",
      },
    );

    const xml = await readDocumentXml(result.output);
    const ids = [...xml.matchAll(/w:id="(\d+)"/g)].map((m) => m[1] ?? "");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps <w:bidi/> run properties when splitting RTL runs", async () => {
    const docx = await makeDocx(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p>
  <w:r><w:rPr><w:bidi/></w:rPr><w:t>abcXYZdef</w:t></w:r>
</w:p></w:body></w:document>`,
    );

    const result = await patchDocxWithTrackChanges(
      docx,
      [issue({ englishExcerpt: "XYZ", correction: "123" })],
      {
        author: "Tester",
        date: "2026-02-25T00:00:00Z",
      },
    );

    const xml = await readDocumentXml(result.output);
    expect(result.applied).toBe(1);
    expect(xml).toContain("<w:bidi");
  });
});
