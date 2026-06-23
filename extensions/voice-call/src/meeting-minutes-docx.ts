/**
 * Deterministic OOXML (.docx) meeting-minutes builder.
 *
 * The end-of-call recap previously asked the model to hand-write an HTML `.doc`, which was neither a
 * real Word document nor deterministic. This builds a minimal but valid OOXML `.docx` entirely in
 * code from (a) the agent's structured summary sections and (b) the speaker-prefixed transcript, so
 * per-speaker attribution is exact and reproducible. We assemble the four fixed parts by hand and zip
 * them into a STORE-method archive using only `node:` built-ins — no zip dependency, so the plugin
 * adds nothing to the dependency graph. The heavier `docx`/`officegen`/`jszip` packages are avoided.
 */

/** One transcript turn. Caller turns may be speaker-prefixed as "<Name>: <text>". */
export type MinutesTranscriptEntry = {
  role: "user" | "assistant";
  text: string;
};

export type BuildMinutesDocxInput = {
  /** Document title, e.g. "Meeting minutes". */
  title: string;
  /** A short call/date line, e.g. "Call with Sara, ~12 min, 2 participants — 2026-06-19". */
  subtitle?: string;
  /**
   * The agent's structured summary as headed sections. Each section becomes a heading followed by
   * its paragraphs (rendered as bullet items). Empty sections are skipped.
   */
  sections?: Array<{ heading: string; items: string[] }>;
  /** Raw transcript turns; rendered verbatim under an "Attributed transcript" heading. */
  transcript: MinutesTranscriptEntry[];
  /** Label for assistant turns in the attributed transcript. Defaults to "Assistant". */
  assistantLabel?: string;
  /** Label for un-prefixed caller turns in the attributed transcript. Defaults to "Caller". */
  callerLabel?: string;
};

const DOCX_CONTENT_TYPE = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

/** XML-escape text for safe inclusion in an OOXML run. */
function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** A normal-weight paragraph. `xml:space="preserve"` keeps leading/trailing spaces intact. */
function paragraph(text: string): string {
  return `<w:p><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
}

/** A bold heading paragraph (no style part needed — bold run + larger size is enough for Word). */
function heading(text: string): string {
  return (
    `<w:p><w:pPr><w:spacing w:before="200" w:after="80"/></w:pPr>` +
    `<w:r><w:rPr><w:b/><w:sz w:val="28"/></w:rPr>` +
    `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  );
}

/** A document title paragraph (largest). */
function title(text: string): string {
  return (
    `<w:p><w:pPr><w:spacing w:after="120"/></w:pPr>` +
    `<w:r><w:rPr><w:b/><w:sz w:val="40"/></w:rPr>` +
    `<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`
  );
}

/** A bullet-style paragraph (rendered with a leading "• " — no numbering part needed). */
function bullet(text: string): string {
  return paragraph(`• ${text}`);
}

/** Build the `word/document.xml` body from the structured input. */
function buildDocumentXml(input: BuildMinutesDocxInput): string {
  const assistantLabel = input.assistantLabel ?? "Assistant";
  const callerLabel = input.callerLabel ?? "Caller";
  const parts: string[] = [];

  parts.push(title(input.title));
  if (input.subtitle?.trim()) {
    parts.push(paragraph(input.subtitle.trim()));
  }

  for (const section of input.sections ?? []) {
    const items = section.items.map((i) => i.trim()).filter(Boolean);
    if (items.length === 0) {
      continue;
    }
    parts.push(heading(section.heading));
    for (const item of items) {
      parts.push(bullet(item));
    }
  }

  // Attributed transcript: rendered deterministically from the speaker-prefixed turns. Caller turns
  // already carry a "<Name>: " prefix from the unmixed-audio attribution, so we keep them verbatim;
  // un-prefixed caller turns fall back to the generic caller label, and assistant turns are labelled.
  parts.push(heading("Attributed transcript"));
  for (const turn of input.transcript) {
    const text = turn.text.trim();
    if (!text) {
      continue;
    }
    if (turn.role === "assistant") {
      parts.push(paragraph(`${assistantLabel}: ${text}`));
    } else if (/^[^\s:][^:]*:\s/.test(text)) {
      // Already speaker-prefixed (e.g. "Sara: …") — keep the exact attribution.
      parts.push(paragraph(text));
    } else {
      parts.push(paragraph(`${callerLabel}: ${text}`));
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
    `<w:body>${parts.join("")}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>` +
    `<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="708" w:footer="708" w:gutter="0"/>` +
    `</w:sectPr></w:body></w:document>`
  );
}

const CONTENT_TYPES_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
  `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
  `<Default Extension="xml" ContentType="application/xml"/>` +
  `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
  `</Types>`;

const ROOT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
  `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
  `</Relationships>`;

const DOCUMENT_RELS_XML =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`;

/** MIME type for a `.docx` (also mapped in `packages/media-core/src/mime.ts`). */
export const MINUTES_DOCX_MIME = DOCX_CONTENT_TYPE;

/** CRC-32 (IEEE) table — the ZIP format requires a CRC even for STORE'd (uncompressed) entries. */
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buf) {
    crc = (crc >>> 8) ^ CRC32_TABLE[(crc ^ byte) & 0xff];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Assemble a ZIP from in-memory entries using the STORE method (no compression). Dependency-free and
 * sufficient for a small `.docx`; entries are written verbatim so any ZIP reader (Word, tests) finds
 * the parts directly.
 */
function buildZip(entries: Array<{ name: string; content: string }>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const { name, content } of entries) {
    const nameBuf = Buffer.from(name, "utf8");
    const data = Buffer.from(content, "utf8");
    const crc = crc32(data);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); // local file header signature
    lh.writeUInt16LE(20, 4); // version needed to extract
    lh.writeUInt16LE(0, 8); // method 0 = store
    lh.writeUInt16LE(0x21, 12); // mod date = 1980-01-01 (deterministic)
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); // compressed size (= uncompressed for store)
    lh.writeUInt32LE(data.length, 22); // uncompressed size
    lh.writeUInt16LE(nameBuf.length, 26);
    local.push(lh, nameBuf, data);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); // central directory header signature
    ch.writeUInt16LE(20, 4); // version made by
    ch.writeUInt16LE(20, 6); // version needed
    ch.writeUInt16LE(0, 10); // method
    ch.writeUInt16LE(0x21, 14); // mod date
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20);
    ch.writeUInt32LE(data.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42); // relative offset of local header
    central.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + data.length;
  }
  const localBuf = Buffer.concat(local);
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(entries.length, 8); // entries on this disk
  eocd.writeUInt16LE(entries.length, 10); // total entries
  eocd.writeUInt32LE(centralBuf.length, 12); // central directory size
  eocd.writeUInt32LE(localBuf.length, 16); // central directory offset
  return Buffer.concat([localBuf, centralBuf, eocd]);
}

/**
 * Build a minimal valid OOXML `.docx` as a Buffer. The bytes are produced entirely in code, so the
 * document — including per-speaker attribution — is deterministic for a given input.
 */
export async function buildMinutesDocx(input: BuildMinutesDocxInput): Promise<Buffer> {
  return buildZip([
    { name: "[Content_Types].xml", content: CONTENT_TYPES_XML },
    { name: "_rels/.rels", content: ROOT_RELS_XML },
    { name: "word/document.xml", content: buildDocumentXml(input) },
    { name: "word/_rels/document.xml.rels", content: DOCUMENT_RELS_XML },
  ]);
}
