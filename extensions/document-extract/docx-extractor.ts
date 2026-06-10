// Docx extractor reads text from .docx (Office Open XML WordprocessingML) attachments.
//
// .docx is a ZIP archive containing one or more XML parts under /word/. The
// human-readable text we want lives inside <w:t> elements in document.xml,
// header*.xml, footer*.xml, footnotes.xml, and endnotes.xml. We avoid pulling
// in a full XML parser: <w:t> runs are well-structured enough that a narrow
// regex pass produces correct output for the common cases (single-namespace
// w:, w:space="preserve"). Paragraph boundaries (</w:p>) become newlines so
// downstream callers see a readable text block instead of a single concatenated
// blob.
import JSZip from "jszip";
import type {
  DocumentExtractionRequest,
  DocumentExtractionResult,
  DocumentExtractorPlugin,
} from "openclaw/plugin-sdk/document-extractor";

/** Order of XML parts to scan inside a .docx archive. document.xml first so
 * body text appears before headers, footers, footnotes, endnotes. */
const DOCX_PART_ORDER: readonly string[] = [
  "word/document.xml",
  "word/footnotes.xml",
  "word/endnotes.xml",
];

const HEADER_FOOTER_PREFIXES: readonly string[] = [
  "word/header",
  "word/footer",
];

/** Maximum decoded characters written into the result. The shared
 * minTextChars/limits live one layer up in input-files; this is a guard
 * against pathological files that would expand into hundreds of MB of text. */
const MAX_EXTRACTED_TEXT_CHARS = 200_000;

/** Decodes the small set of XML entities that appear inside w:t runs. Avoids
 * pulling in a full entity table — Office writers only emit these five. */
function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

/** Extracts visible text from a single OOXML part. Returns an empty string
 * when the part has no readable runs. */
export function extractTextFromOoxmlPart(xml: string): string {
  if (!xml) {
    return "";
  }
  // Split on paragraph boundaries so each paragraph becomes its own line. Then
  // pull <w:t>...</w:t> runs out of each paragraph and join with no separator
  // (runs inside one paragraph are continuous text).
  const paragraphs = xml.split(/<\/w:p\s*>/);
  const lines: string[] = [];
  const runMatcher = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t\s*>/g;
  for (const paragraph of paragraphs) {
    let text = "";
    let match: RegExpExecArray | null;
    runMatcher.lastIndex = 0;
    while ((match = runMatcher.exec(paragraph)) !== null) {
      text += decodeXmlEntities(match[1] ?? "");
    }
    if (text.length > 0) {
      lines.push(text);
    }
  }
  return lines.join("\n");
}

async function readPartText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) {
    return "";
  }
  try {
    return await entry.async("string");
  } catch {
    return "";
  }
}

async function extractDocxContent(
  request: DocumentExtractionRequest,
): Promise<DocumentExtractionResult> {
  const zip = await JSZip.loadAsync(new Uint8Array(request.buffer));

  const segments: string[] = [];
  let remaining = MAX_EXTRACTED_TEXT_CHARS;

  const append = (segment: string): boolean => {
    if (remaining <= 0 || !segment) {
      return remaining > 0;
    }
    if (segment.length > remaining) {
      segments.push(segment.slice(0, remaining));
      remaining = 0;
      return false;
    }
    segments.push(segment);
    remaining -= segment.length;
    return remaining > 0;
  };

  for (const part of DOCX_PART_ORDER) {
    const xml = await readPartText(zip, part);
    if (!xml) {
      continue;
    }
    const text = extractTextFromOoxmlPart(xml);
    if (!append(text)) {
      break;
    }
    if (text) {
      // Visual separator between parts so footnotes don't blur into the body.
      if (!append("\n")) {
        break;
      }
    }
  }

  if (remaining > 0) {
    const headerFooterPaths = Object.keys(zip.files)
      .filter(
        (path) =>
          HEADER_FOOTER_PREFIXES.some((prefix) => path.startsWith(prefix)) &&
          path.endsWith(".xml"),
      )
      .toSorted();
    for (const part of headerFooterPaths) {
      const xml = await readPartText(zip, part);
      if (!xml) {
        continue;
      }
      const text = extractTextFromOoxmlPart(xml);
      if (!append(text)) {
        break;
      }
      if (text && !append("\n")) {
        break;
      }
    }
  }

  // Trim trailing newlines added between parts; preserve trailing spaces inside
  // text since `<w:t xml:space="preserve">` deliberately emits them.
  return { text: segments.join("").replace(/\n+$/, ""), images: [] };
}

export function createDocxDocumentExtractor(): DocumentExtractorPlugin {
  return {
    id: "docx",
    label: "DOCX",
    mimeTypes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    autoDetectOrder: 20,
    extract: extractDocxContent,
  };
}
