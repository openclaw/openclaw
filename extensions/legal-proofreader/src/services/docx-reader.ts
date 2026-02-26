import mammoth from "mammoth";
import { readFile } from "node:fs/promises";

const EN_ORDINAL_TO_DIGIT: Record<string, string> = {
  one: "1",
  first: "1",
  two: "2",
  second: "2",
  three: "3",
  third: "3",
  four: "4",
  fourth: "4",
  five: "5",
  fifth: "5",
  six: "6",
  sixth: "6",
  seven: "7",
  seventh: "7",
  eight: "8",
  eighth: "8",
  nine: "9",
  ninth: "9",
  ten: "10",
  tenth: "10",
  eleven: "11",
  twelfth: "12",
  twelve: "12",
  thirteen: "13",
  fourteen: "14",
  fifteen: "15",
  sixteen: "16",
  seventeen: "17",
  eighteen: "18",
  nineteen: "19",
  twenty: "20",
};

function normalizeArticleId(raw: string): string {
  const cleaned = raw.replace(/[()]/g, "").trim();
  const lower = cleaned.toLowerCase();
  const mapped = EN_ORDINAL_TO_DIGIT[lower];
  if (mapped) {
    return mapped;
  }
  const numeric = cleaned.match(/\d+[a-zA-Z]*/);
  return numeric?.[0] ?? cleaned;
}

export async function extractDocxBuffer(filePath: string): Promise<Buffer> {
  return await readFile(filePath);
}

export function splitArticlesFromRawText(
  rawText: string,
): Array<{ articleId: string; text: string }> {
  const text = rawText.replace(/\r\n/g, "\n");
  const headingRe = /^\s*Article\s+(\(?\d+[a-zA-Z]*\)?|[A-Za-z]+)\b/gim;
  const matches = Array.from(text.matchAll(headingRe));

  if (matches.length === 0) {
    const cleaned = text.trim();
    return [{ articleId: "", text: cleaned }];
  }

  const entries: Array<{ articleId: string; text: string }> = [];

  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    if (!current || current.index === undefined) {
      continue;
    }
    const next = matches[i + 1];
    const start = current.index;
    const end = next?.index ?? text.length;
    const articleId = normalizeArticleId((current[1] ?? "").trim());
    const section = text.slice(start, end).trim();
    entries.push({ articleId, text: section });
  }

  return entries;
}

export async function extractDocxArticles(
  docxBuffer: Buffer,
): Promise<Array<{ articleId: string; text: string }>> {
  const result = await mammoth.extractRawText({ buffer: docxBuffer });
  const rawText = result.value ?? "";
  return splitArticlesFromRawText(rawText);
}
