import JSZip from "jszip";
import { DOMParser } from "linkedom";
import type { IssueRecord } from "../types.js";

type PatchResult = {
  output: Buffer;
  applied: number;
  failed: Array<{ issueId: string; reason: string }>;
};

type XmlElement = Element;
type XmlDocument = {
  getElementsByTagName: (name: string) => HtmlCollectionLike;
  createElementNS: (ns: string, name: string) => XmlElement;
  toString: () => string;
};
type HtmlCollectionLike = ArrayLike<XmlElement>;

type TextNodeRef = {
  node: XmlElement;
  text: string;
  start: number;
  end: number;
};

type TextRange = {
  start: number;
  end: number;
};

type ArticleRange = TextRange & {
  articleKey: string;
};

const ENGLISH_ORDINAL_TO_DIGIT: Record<string, string> = {
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

function normalizeArticleKey(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return "";
  }

  const direct = ENGLISH_ORDINAL_TO_DIGIT[trimmed];
  if (direct) {
    return direct;
  }

  const match = trimmed.match(/\d+[a-z]?/i);
  if (match?.[0]) {
    return match[0].toLowerCase();
  }

  return trimmed;
}

function findArticleRanges(text: string): ArticleRange[] {
  const headingRegex = /\bArticle\s+(\(?\d+[a-zA-Z]?\)?|[A-Za-z]+)\b/gi;
  const matches = Array.from(text.matchAll(headingRegex));
  if (matches.length === 0) {
    return [];
  }

  const ranges: ArticleRange[] = [];
  for (let i = 0; i < matches.length; i += 1) {
    const current = matches[i];
    if (!current || current.index === undefined) {
      continue;
    }
    const next = matches[i + 1];
    const articleKey = normalizeArticleKey((current[1] ?? "").replace(/[()]/g, ""));
    if (!articleKey) {
      continue;
    }
    ranges.push({
      articleKey,
      start: current.index,
      end: next?.index ?? text.length,
    });
  }

  return ranges;
}

function findFirstInRange(text: string, target: string, range: TextRange): number {
  const found = text.indexOf(target, range.start);
  if (found < 0 || found + target.length > range.end) {
    return -1;
  }
  return found;
}

function resolveTargetIndex(params: {
  logicalText: string;
  target: string;
  article: string;
  articleRanges: ArticleRange[];
}): number {
  const { logicalText, target, article, articleRanges } = params;
  const articleKey = normalizeArticleKey(article);

  if (articleKey) {
    const scopedRanges = articleRanges.filter((range) => range.articleKey === articleKey);
    for (const range of scopedRanges) {
      const index = findFirstInRange(logicalText, target, range);
      if (index >= 0) {
        return index;
      }
    }
  }

  return findFirstInRange(logicalText, target, { start: 0, end: logicalText.length });
}

function findAncestorByTag(node: XmlElement, tagNameLower: string): XmlElement | null {
  let current: XmlElement | null = node;
  while (current) {
    if (current.tagName.toLowerCase() === tagNameLower) {
      return current;
    }
    current = current.parentElement;
  }
  return null;
}

function isWithin(node: XmlElement, tagNameLower: string): boolean {
  let parent = node.parentElement;
  while (parent) {
    if (parent.tagName.toLowerCase() === tagNameLower) {
      return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

function collectTextNodes(doc: XmlDocument): { text: string; refs: TextNodeRef[] } {
  const refs: TextNodeRef[] = [];
  let text = "";
  const runs = Array.from(doc.getElementsByTagName("w:r"));

  for (const run of runs) {
    if (isWithin(run, "w:del")) {
      continue;
    }
    const textNodes = Array.from(run.getElementsByTagName("w:t"));
    for (const node of textNodes) {
      const fragment = node.textContent ?? "";
      if (!fragment) {
        continue;
      }
      const start = text.length;
      text += fragment;
      refs.push({ node, text: fragment, start, end: text.length });
    }
  }

  return { text, refs };
}

function createRunWithText(
  doc: XmlDocument,
  baseRun: XmlElement,
  tag: "w:delText" | "w:t",
  text: string,
): XmlElement {
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const run = doc.createElementNS(ns, "w:r");
  const runPr = baseRun.getElementsByTagName("w:rPr")[0];
  if (runPr) {
    run.appendChild(runPr.cloneNode(true));
  }
  const t = doc.createElementNS(ns, tag);
  t.setAttribute("xml:space", "preserve");
  t.textContent = text;
  run.appendChild(t);
  return run;
}

function injectChangePair(params: {
  doc: XmlDocument;
  targetTextNode: XmlElement;
  oldText: string;
  newText: string;
  idBase: number;
  author: string;
  date: string;
}): boolean {
  const { doc, targetTextNode, oldText, newText, idBase, author, date } = params;

  const fullText = targetTextNode.textContent ?? "";
  const idx = fullText.indexOf(oldText);
  if (idx < 0) {
    return false;
  }

  const before = fullText.slice(0, idx);
  const after = fullText.slice(idx + oldText.length);
  const run = findAncestorByTag(targetTextNode, "w:r");
  if (!run || !run.parentElement) {
    return false;
  }
  const parent = run.parentElement;
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

  const nodesToInsert: Node[] = [];
  if (before) {
    nodesToInsert.push(createRunWithText(doc, run, "w:t", before));
  }

  const del = doc.createElementNS(ns, "w:del");
  del.setAttribute("w:id", String(idBase));
  del.setAttribute("w:author", author);
  del.setAttribute("w:date", date);
  del.appendChild(createRunWithText(doc, run, "w:delText", oldText));
  nodesToInsert.push(del);

  const ins = doc.createElementNS(ns, "w:ins");
  ins.setAttribute("w:id", String(idBase + 1));
  ins.setAttribute("w:author", author);
  ins.setAttribute("w:date", date);
  ins.appendChild(createRunWithText(doc, run, "w:t", newText));
  nodesToInsert.push(ins);

  if (after) {
    nodesToInsert.push(createRunWithText(doc, run, "w:t", after));
  }

  for (const node of nodesToInsert) {
    parent.insertBefore(node, run);
  }
  parent.removeChild(run);
  return true;
}

function injectChangePairAcrossRuns(params: {
  doc: XmlDocument;
  startTextNode: XmlElement;
  endTextNode: XmlElement;
  oldText: string;
  newText: string;
  idBase: number;
  author: string;
  date: string;
  globalStartInRef: number;
  globalEndInRef: number;
}): boolean {
  const {
    doc,
    startTextNode,
    endTextNode,
    oldText,
    newText,
    idBase,
    author,
    date,
    globalStartInRef,
    globalEndInRef,
  } = params;

  const startRun = findAncestorByTag(startTextNode, "w:r");
  const endRun = findAncestorByTag(endTextNode, "w:r");
  if (!startRun || !endRun || !startRun.parentElement || !endRun.parentElement) {
    return false;
  }
  if (startRun.parentElement !== endRun.parentElement) {
    return false;
  }

  const parent = startRun.parentElement;
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";

  const startText = startTextNode.textContent ?? "";
  const endText = endTextNode.textContent ?? "";
  const before = startText.slice(0, Math.max(0, globalStartInRef));
  const after = endText.slice(Math.max(0, globalEndInRef));

  const nodesToInsert: Node[] = [];
  if (before) {
    nodesToInsert.push(createRunWithText(doc, startRun, "w:t", before));
  }

  const del = doc.createElementNS(ns, "w:del");
  del.setAttribute("w:id", String(idBase));
  del.setAttribute("w:author", author);
  del.setAttribute("w:date", date);
  del.appendChild(createRunWithText(doc, startRun, "w:delText", oldText));
  nodesToInsert.push(del);

  const ins = doc.createElementNS(ns, "w:ins");
  ins.setAttribute("w:id", String(idBase + 1));
  ins.setAttribute("w:author", author);
  ins.setAttribute("w:date", date);
  ins.appendChild(createRunWithText(doc, startRun, "w:t", newText));
  nodesToInsert.push(ins);

  if (after) {
    nodesToInsert.push(createRunWithText(doc, endRun, "w:t", after));
  }

  for (const node of nodesToInsert) {
    parent.insertBefore(node, startRun);
  }

  let cursor: ChildNode | null = startRun;
  while (cursor) {
    const next: ChildNode | null = cursor.nextSibling;
    parent.removeChild(cursor);
    if (cursor === endRun) {
      break;
    }
    cursor = next;
  }

  return true;
}

function scanMaxChangeId(xml: string): number {
  const matches = [...xml.matchAll(/w:id="(\d+)"/g)].map((m) => Number.parseInt(m[1] ?? "0", 10));
  if (matches.length === 0) {
    return 0;
  }
  return Math.max(...matches);
}

export async function patchDocxWithTrackChanges(
  docxBuffer: Buffer,
  corrections: IssueRecord[],
  opts: { author: string; date: string },
): Promise<PatchResult> {
  const zip = await JSZip.loadAsync(docxBuffer);
  const file = zip.file("word/document.xml");
  if (!file) {
    throw new Error("Invalid DOCX: missing word/document.xml");
  }

  const xml = await file.async("string");
  const parser = new DOMParser();
  const doc = parser.parseFromString(xml, "text/xml") as unknown as XmlDocument;

  let nextId = scanMaxChangeId(xml) + 1;
  let applied = 0;
  const failed: Array<{ issueId: string; reason: string }> = [];

  const sorted = corrections.toSorted((a, b) => {
    const aN = Number.parseInt(a.article.match(/\d+/)?.[0] ?? "999999", 10);
    const bN = Number.parseInt(b.article.match(/\d+/)?.[0] ?? "999999", 10);
    return aN - bN;
  });

  for (const correction of sorted) {
    const logical = collectTextNodes(doc);
    const target = correction.englishExcerpt;
    if (!target) {
      failed.push({ issueId: correction.issueId, reason: "englishExcerpt is empty" });
      continue;
    }

    const articleRanges = findArticleRanges(logical.text);
    const globalIndex = resolveTargetIndex({
      logicalText: logical.text,
      target,
      article: correction.article,
      articleRanges,
    });
    if (globalIndex < 0) {
      failed.push({ issueId: correction.issueId, reason: "Target text not found" });
      continue;
    }

    const rangeStart = globalIndex;
    const rangeEnd = globalIndex + target.length;

    const startRef = logical.refs.find((ref) => ref.start <= rangeStart && ref.end > rangeStart);
    const endRef = logical.refs.find((ref) => ref.start < rangeEnd && ref.end >= rangeEnd);

    if (!startRef || !endRef) {
      failed.push({
        issueId: correction.issueId,
        reason: "Target text location could not be resolved",
      });
      continue;
    }

    const ok =
      startRef === endRef
        ? injectChangePair({
            doc,
            targetTextNode: startRef.node,
            oldText: target,
            newText: correction.correction,
            idBase: nextId,
            author: opts.author,
            date: opts.date,
          })
        : injectChangePairAcrossRuns({
            doc,
            startTextNode: startRef.node,
            endTextNode: endRef.node,
            oldText: target,
            newText: correction.correction,
            idBase: nextId,
            author: opts.author,
            date: opts.date,
            globalStartInRef: rangeStart - startRef.start,
            globalEndInRef: rangeEnd - endRef.start,
          });

    if (!ok) {
      failed.push({ issueId: correction.issueId, reason: "Failed to inject track changes" });
      continue;
    }

    nextId += 2;
    applied += 1;
  }

  const updatedXml = doc.toString();
  zip.file("word/document.xml", updatedXml);
  const output = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });

  return { output, applied, failed };
}
