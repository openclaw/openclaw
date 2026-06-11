import fs from "node:fs/promises";
import path from "node:path";
import { escapeHtml } from "./text.js";
import type { BookBible, BookOutline } from "./types.js";

type ZipEntry = {
  name: string;
  content: Buffer;
};

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let c = index;
  for (let k = 0; k < 8; k += 1) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return c >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUInt16(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function writeUInt32(value: number): Buffer {
  const buffer = Buffer.allocUnsafe(4);
  buffer.writeUInt32LE(value >>> 0);
  return buffer;
}

function zipStore(entries: ZipEntry[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.content);
    const localHeader = Buffer.concat([
      writeUInt32(0x04034b50),
      writeUInt16(20),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt16(0),
      writeUInt32(crc),
      writeUInt32(entry.content.length),
      writeUInt32(entry.content.length),
      writeUInt16(name.length),
      writeUInt16(0),
      name,
    ]);
    localParts.push(localHeader, entry.content);
    centralParts.push(
      Buffer.concat([
        writeUInt32(0x02014b50),
        writeUInt16(20),
        writeUInt16(20),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt32(crc),
        writeUInt32(entry.content.length),
        writeUInt32(entry.content.length),
        writeUInt16(name.length),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt16(0),
        writeUInt32(0),
        writeUInt32(offset),
        name,
      ]),
    );
    offset += localHeader.length + entry.content.length;
  }
  const central = Buffer.concat(centralParts);
  const local = Buffer.concat(localParts);
  const end = Buffer.concat([
    writeUInt32(0x06054b50),
    writeUInt16(0),
    writeUInt16(0),
    writeUInt16(entries.length),
    writeUInt16(entries.length),
    writeUInt32(central.length),
    writeUInt32(local.length),
    writeUInt16(0),
  ]);
  return Buffer.concat([local, central, end]);
}

function chapterToXhtml(title: string, markdown: string): string {
  const paragraphs = markdown
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replace(/\n/g, "<br />")}</p>`)
    .join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" lang="en">
<head><title>${escapeHtml(title)}</title></head>
<body><h1>${escapeHtml(title)}</h1>${paragraphs}</body>
</html>`;
}

function epubModifiedTimestamp(createdAt: string): string {
  const date = new Date(createdAt);
  const safeDate = Number.isNaN(date.getTime()) ? new Date(0) : date;
  return safeDate.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export async function writeEpub(params: {
  outputPath: string;
  bible: BookBible;
  outline: BookOutline;
  manuscript: string;
}): Promise<void> {
  const chapterBlocks = params.manuscript
    .split(/^## Chapter\s+\d+:\s+/gm)
    .map((block) => block.trim())
    .filter(Boolean)
    .slice(1);
  const chapterEntries = params.outline.chapters.map((chapter, index) => {
    const body = chapterBlocks[index]?.replace(new RegExp(`^${chapter.title}\\s*`), "") ?? "";
    return {
      name: `OEBPS/chapter-${chapter.number}.xhtml`,
      content: Buffer.from(chapterToXhtml(chapter.title, body), "utf8"),
    };
  });
  const manifestItems = params.outline.chapters
    .map(
      (chapter) =>
        `<item id="chapter-${chapter.number}" href="chapter-${chapter.number}.xhtml" media-type="application/xhtml+xml" />`,
    )
    .join("\n    ");
  const spineItems = params.outline.chapters
    .map((chapter) => `<itemref idref="chapter-${chapter.number}" />`)
    .join("\n    ");
  const navItems = params.outline.chapters
    .map(
      (chapter) =>
        `<li><a href="chapter-${chapter.number}.xhtml">${escapeHtml(chapter.title)}</a></li>`,
    )
    .join("\n        ");
  const modified = epubModifiedTimestamp(params.bible.createdAt);
  const entries: ZipEntry[] = [
    { name: "mimetype", content: Buffer.from("application/epub+zip", "utf8") },
    {
      name: "META-INF/container.xml",
      content: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`,
        "utf8",
      ),
    },
    {
      name: "OEBPS/nav.xhtml",
      content: Buffer.from(
        `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en">
<head><title>${escapeHtml(params.bible.title)}</title></head>
<body><nav epub:type="toc"><h1>Contents</h1><ol>${navItems}</ol></nav></body>
</html>`,
        "utf8",
      ),
    },
    {
      name: "OEBPS/content.opf",
      content: Buffer.from(
        `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" unique-identifier="book-id" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:openclaw:${escapeHtml(params.bible.runId)}</dc:identifier>
    <dc:title>${escapeHtml(params.bible.title)}</dc:title>
    <dc:creator>${escapeHtml(params.bible.penName)}</dc:creator>
    <dc:language>en</dc:language>
    <meta property="dcterms:modified">${modified}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    ${manifestItems}
  </manifest>
  <spine>
    ${spineItems}
  </spine>
</package>`,
        "utf8",
      ),
    },
    ...chapterEntries,
  ];
  await fs.mkdir(path.dirname(params.outputPath), { recursive: true });
  await fs.writeFile(params.outputPath, zipStore(entries));
}
