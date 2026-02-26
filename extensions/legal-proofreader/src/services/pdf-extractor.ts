import { getDocument, type TextContent } from "pdfjs-dist/legacy/build/pdf.mjs";

const CMAP_URL = new URL("../../../../node_modules/pdfjs-dist/cmaps/", import.meta.url).toString();

const ARABIC_ORDINAL_TO_DIGIT: Record<string, string> = {
  الأولى: "1",
  الثانية: "2",
  الثالثة: "3",
  الرابعة: "4",
  الخامسة: "5",
  السادسة: "6",
  السابعة: "7",
  الثامنة: "8",
  التاسعة: "9",
  العاشرة: "10",
  "الحادية عشرة": "11",
  "الثانية عشرة": "12",
  "الثالثة عشرة": "13",
  "الرابعة عشرة": "14",
  "الخامسة عشرة": "15",
  "السادسة عشرة": "16",
  "السابعة عشرة": "17",
  "الثامنة عشرة": "18",
  "التاسعة عشرة": "19",
  العشرون: "20",
};

export const ARABIC_ARTICLE_HEADING_RE = /^(المادة\s+(الأولى|الثانية|الثالثة|\d+))/u;

type PositionedTextItem = {
  str: string;
  x: number;
  y: number;
};

function isTextLikeItem(item: unknown): item is { str: string; transform?: number[] } {
  if (!item || typeof item !== "object") {
    return false;
  }
  const candidate = item as { str?: unknown };
  return typeof candidate.str === "string";
}

export function sortArabicTextItems(items: PositionedTextItem[]): PositionedTextItem[] {
  return items.toSorted((a, b) => {
    if (a.y !== b.y) {
      return b.y - a.y;
    }
    return b.x - a.x;
  });
}

function toPositionedItems(content: TextContent): PositionedTextItem[] {
  const positioned: PositionedTextItem[] = [];
  for (const item of content.items) {
    if (!isTextLikeItem(item)) {
      continue;
    }
    const transform = Array.isArray(item.transform) ? item.transform : undefined;
    const x = typeof transform?.[4] === "number" ? transform[4] : 0;
    const y = typeof transform?.[5] === "number" ? transform[5] : 0;
    positioned.push({ str: item.str, x, y });
  }
  return sortArabicTextItems(positioned);
}

function toPageLines(items: PositionedTextItem[]): string[] {
  if (items.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let currentY = items[0]?.y ?? 0;
  let currentLine = "";
  const yTolerance = 2;

  for (const item of items) {
    const text = item.str.trim();
    if (!text) {
      continue;
    }

    if (Math.abs(item.y - currentY) > yTolerance) {
      if (currentLine.trim()) {
        lines.push(currentLine.trim());
      }
      currentLine = text;
      currentY = item.y;
      continue;
    }

    currentLine = currentLine ? `${currentLine} ${text}` : text;
  }

  if (currentLine.trim()) {
    lines.push(currentLine.trim());
  }

  return lines;
}

function normalizeArabicArticleToken(token: string): string {
  const trimmed = token.trim();
  const direct = ARABIC_ORDINAL_TO_DIGIT[trimmed];
  if (direct) {
    return direct;
  }

  const digitsMatch = trimmed.match(/\d+/);
  if (digitsMatch?.[0]) {
    return digitsMatch[0];
  }

  return trimmed;
}

function extractArticleKeyFromLine(line: string): string | null {
  const normalized = line.normalize("NFC").trim();
  const headingMatch = normalized.match(/^المادة\s+(.+)$/u);
  if (!headingMatch?.[1]) {
    return null;
  }

  const candidate = headingMatch[1].trim().split(/\s+/u)[0] ?? "";
  if (!candidate) {
    return null;
  }
  return normalizeArabicArticleToken(candidate);
}

export async function extractArabicPdfText(
  pdfBuffer: Uint8Array,
): Promise<{ pages: string[]; articleTexts: Record<string, string> }> {
  const params = {
    data: pdfBuffer,
    disableWorker: true,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    disableFontFace: true,
  } as Record<string, unknown>;

  const pdf = await getDocument(params as { data: Uint8Array; disableWorker?: boolean }).promise;
  const pages: string[] = [];
  const articleTexts: Record<string, string> = {};

  let currentArticle: string | null = null;

  for (let pageNo = 1; pageNo <= pdf.numPages; pageNo += 1) {
    const page = await pdf.getPage(pageNo);
    const content = await (
      page.getTextContent as unknown as (params?: {
        disableNormalization?: boolean;
      }) => Promise<TextContent>
    ).call(page, { disableNormalization: false });
    const items = toPositionedItems(content);
    const lines = toPageLines(items);
    const pageText = lines.join("\n");
    pages.push(pageText);

    for (const rawLine of lines) {
      const line = rawLine.normalize("NFC").trim();
      if (!line) {
        continue;
      }

      if (ARABIC_ARTICLE_HEADING_RE.test(line)) {
        const key = extractArticleKeyFromLine(line);
        if (key) {
          currentArticle = key;
          articleTexts[currentArticle] = articleTexts[currentArticle]
            ? `${articleTexts[currentArticle]}\n${line}`
            : line;
          continue;
        }
      }

      if (currentArticle) {
        articleTexts[currentArticle] = articleTexts[currentArticle]
          ? `${articleTexts[currentArticle]}\n${line}`
          : line;
      }
    }
  }

  return { pages, articleTexts };
}
