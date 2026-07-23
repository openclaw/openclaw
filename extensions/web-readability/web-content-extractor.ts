// Web Readability plugin module implements web content extractor behavior.
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  htmlToMarkdown,
  normalizeWhitespace,
  sanitizeHtml,
  stripInvisibleUnicode,
  type WebContentExtractionRequest,
  type WebContentExtractorPlugin,
} from "openclaw/plugin-sdk/web-content-extractor";

const READABILITY_MAX_HTML_CHARS = 1_000_000;
const READABILITY_MAX_ESTIMATED_NESTING_DEPTH = 3_000;
const HTML_MAX_TAG_SCAN_CHARS = 200;
const HTML_VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const HTML_RAW_TEXT_TAGS = new Set([
  "iframe",
  "noembed",
  "noframes",
  "plaintext",
  "script",
  "style",
  "textarea",
  "title",
  "xmp",
]);

const READABILITY_MODULE = "@mozilla/readability";
const LINKEDOM_MODULE = "linkedom";

const loadReadabilityDeps = createLazyRuntimeModule(() =>
  Promise.all([
    import(READABILITY_MODULE) as Promise<typeof import("@mozilla/readability")>,
    import(LINKEDOM_MODULE) as Promise<typeof import("linkedom")>,
  ]),
);

function findClosingRawTextTagStart(lowerHtml: string, tagName: string, start: number): number {
  const closingPrefix = `</${tagName}`;
  for (
    let index = lowerHtml.indexOf(closingPrefix, start);
    index >= 0;
    index = lowerHtml.indexOf(closingPrefix, index + closingPrefix.length)
  ) {
    const afterName = index + closingPrefix.length;
    const boundary = lowerHtml.charCodeAt(afterName);
    if (afterName >= lowerHtml.length || boundary <= 32 || boundary === 47 || boundary === 62) {
      return index;
    }
  }
  return -1;
}

export function exceedsEstimatedHtmlNestingDepth(html: string, maxDepth: number): boolean {
  let depth = 0;
  const len = html.length;
  const lowerHtml = html.toLowerCase();
  for (let i = 0; i < len; i++) {
    if (html.charCodeAt(i) !== 60) {
      continue;
    }
    const next = html.charCodeAt(i + 1);
    if (next === 33 || next === 63) {
      continue;
    }

    let j = i + 1;
    let closing = false;
    if (html.charCodeAt(j) === 47) {
      closing = true;
      j += 1;
    }

    while (j < len && html.charCodeAt(j) <= 32) {
      j += 1;
    }

    const nameStart = j;
    while (j < len) {
      const c = html.charCodeAt(j);
      const isNameChar =
        (c >= 65 && c <= 90) ||
        (c >= 97 && c <= 122) ||
        (c >= 48 && c <= 57) ||
        c === 58 ||
        c === 45;
      if (!isNameChar) {
        break;
      }
      j += 1;
    }

    if (j === nameStart) {
      continue;
    }

    if (closing) {
      if (depth > 0) {
        depth -= 1;
      }
      continue;
    }
    const tagName = lowerHtml.slice(nameStart, j);
    if (HTML_VOID_TAGS.has(tagName)) {
      continue;
    }

    let quote = 0;
    let tagEnd = -1;
    for (let k = j; k < len && k < j + HTML_MAX_TAG_SCAN_CHARS; k += 1) {
      const c = html.charCodeAt(k);
      if (quote) {
        if (c === quote) {
          quote = 0;
        }
        continue;
      }
      if (c === 34 || c === 39) {
        quote = c;
        continue;
      }
      if (c === 62) {
        tagEnd = k;
        break;
      }
    }
    const selfClosing = tagEnd >= 0 && html.slice(j, tagEnd).trimEnd().endsWith("/");
    if (selfClosing) {
      continue;
    }

    // Count apparent starts conservatively even when the bounded scan misses a distant `>`.
    depth += 1;
    if (depth > maxDepth) {
      return true;
    }
    if (tagEnd >= 0 && HTML_RAW_TEXT_TAGS.has(tagName)) {
      const closingStart = findClosingRawTextTagStart(lowerHtml, tagName, tagEnd + 1);
      if (closingStart >= 0) {
        i = closingStart - 1;
      } else {
        break;
      }
    }
  }
  return false;
}

async function extractWithReadability(request: WebContentExtractionRequest) {
  const cleanHtml = await sanitizeHtml(request.html);
  if (
    cleanHtml.length > READABILITY_MAX_HTML_CHARS ||
    exceedsEstimatedHtmlNestingDepth(cleanHtml, READABILITY_MAX_ESTIMATED_NESTING_DEPTH)
  ) {
    return null;
  }
  try {
    const [{ Readability }, { parseHTML }] = await loadReadabilityDeps();
    const { document } = parseHTML(cleanHtml, { location: { href: request.url } });
    const reader = new Readability(document);
    const parsed = reader.parse();
    if (!parsed?.content) {
      return null;
    }
    const title = parsed.title || undefined;
    const rendered =
      request.extractMode === "text"
        ? { text: normalizeWhitespace(parsed.textContent ?? ""), title }
        : htmlToMarkdown(parsed.content);
    const text = stripInvisibleUnicode(rendered.text);
    return text ? { text, title: title ?? rendered.title } : null;
  } catch {
    return null;
  }
}

export function createReadabilityWebContentExtractor(): WebContentExtractorPlugin {
  return {
    id: "readability",
    label: "Readability",
    autoDetectOrder: 10,
    extract: extractWithReadability,
  };
}
