import type { AlignedArticle, GlossaryEntry } from "../types.js";

const ARABIC_ORDINAL_MAP: Record<string, string> = {
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

function normalizeArabicArticleKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) {
    return "";
  }
  const direct = ARABIC_ORDINAL_MAP[trimmed];
  if (direct) {
    return direct;
  }
  const digits = trimmed.match(/\d+/)?.[0];
  return digits ?? trimmed;
}

function normalizeEnglishArticleId(articleId: string): string {
  const trimmed = articleId.trim();
  if (!trimmed) {
    return "";
  }
  const headingMatch = trimmed.match(/^article\s+(\d+[a-zA-Z]?)$/i);
  if (headingMatch?.[1]) {
    return headingMatch[1].toLowerCase();
  }
  return trimmed.toLowerCase();
}

function toArticleNumericOrder(value: string): number {
  const digits = value.match(/\d+/)?.[0];
  if (!digits) {
    return Number.POSITIVE_INFINITY;
  }
  return Number.parseInt(digits, 10);
}

function extractGlossaryFromText(text: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];

  const englishPattern = /"([^"\n]+)"\s+means\s+"([^"\n]+)"/gim;
  for (const match of text.matchAll(englishPattern)) {
    const arabicTerm = (match[1] ?? "").trim();
    const englishTerm = (match[2] ?? "").trim();
    if (arabicTerm && englishTerm) {
      entries.push({ arabicTerm, englishTerm });
    }
  }

  const arabicPattern = /يُقصد\s+بـ\s*"([^"\n]+)"/gu;
  for (const match of text.matchAll(arabicPattern)) {
    const arabicTerm = (match[1] ?? "").trim();
    if (!arabicTerm) {
      continue;
    }
    entries.push({ arabicTerm, englishTerm: "" });
  }

  const dedup = new Map<string, GlossaryEntry>();
  for (const entry of entries) {
    const key = `${entry.arabicTerm}||${entry.englishTerm}`;
    if (!dedup.has(key)) {
      dedup.set(key, entry);
    }
  }
  return [...dedup.values()];
}

export function alignArticles(
  arabicTexts: Record<string, string>,
  englishArticles: Array<{ articleId: string; text: string }>,
): { aligned: AlignedArticle[]; glossary: GlossaryEntry[] } {
  const arabicEntries = Object.entries(arabicTexts).map(([rawKey, text]) => ({
    rawKey,
    key: normalizeArabicArticleKey(rawKey),
    text,
  }));
  const englishEntries = englishArticles.map((entry) => ({
    ...entry,
    key: normalizeEnglishArticleId(entry.articleId),
  }));

  const usedEnglish = new Set<number>();
  const aligned: AlignedArticle[] = [];

  for (const arabic of arabicEntries) {
    const matchIndex = englishEntries.findIndex((entry, idx) => {
      if (usedEnglish.has(idx)) {
        return false;
      }
      return normalizeEnglishArticleId(entry.key) === normalizeEnglishArticleId(arabic.key);
    });

    if (matchIndex >= 0) {
      usedEnglish.add(matchIndex);
      const english = englishEntries[matchIndex];
      aligned.push({
        articleId: arabic.key || english.articleId || arabic.rawKey,
        arabicText: arabic.text,
        englishText: english?.text ?? "",
        pageRef: "",
      });
      continue;
    }

    aligned.push({
      articleId: arabic.key || arabic.rawKey,
      arabicText: arabic.text,
      englishText: "",
      pageRef: "",
    });
  }

  for (let i = 0; i < englishEntries.length; i += 1) {
    if (usedEnglish.has(i)) {
      continue;
    }
    const english = englishEntries[i];
    aligned.push({
      articleId: english?.articleId ?? "",
      arabicText: "",
      englishText: english?.text ?? "",
      pageRef: "",
    });
  }

  const ordered = aligned.toSorted((a, b) => {
    const aOrder = toArticleNumericOrder(a.articleId);
    const bOrder = toArticleNumericOrder(b.articleId);
    if (aOrder !== bOrder) {
      return aOrder - bOrder;
    }
    return a.articleId.localeCompare(b.articleId);
  });

  const glossarySource = ordered
    .slice(0, 3)
    .map((entry) => `${entry.arabicText}\n${entry.englishText}`)
    .join("\n");
  const glossary = extractGlossaryFromText(glossarySource);

  return { aligned: ordered, glossary };
}
