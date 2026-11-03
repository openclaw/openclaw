import type {
  RichTextBlock,
  RichTextElement,
  RichTextLink,
  RichTextSection,
  RichTextText,
} from "@slack/types";
import type { MarkdownIR } from "openclaw/plugin-sdk/text-chunking";

function renderInline(ir: MarkdownIR, start: number, end: number): RichTextElement[] {
  const boundaries = new Set([start, end]);
  for (const span of [...ir.styles, ...ir.links]) {
    if (span.start > start && span.start < end) {
      boundaries.add(span.start);
    }
    if (span.end > start && span.end < end) {
      boundaries.add(span.end);
    }
  }
  const offsets = [...boundaries].toSorted((a, b) => a - b);
  return offsets.slice(0, -1).map((offset, index) => {
    const text = ir.text.slice(offset, offsets[index + 1]);
    const style: NonNullable<RichTextText["style"]> = {};
    for (const span of ir.styles) {
      if (span.start <= offset && span.end > offset) {
        if (span.style === "bold" || span.style.startsWith("heading_")) {
          style.bold = true;
        }
        if (span.style === "italic") {
          style.italic = true;
        }
        if (span.style === "strikethrough") {
          style.strike = true;
        }
        if (span.style === "code") {
          style.code = true;
        }
      }
    }
    const link = ir.links.find((span) => span.start <= offset && span.end > offset);
    const element: RichTextLink | RichTextText = link
      ? { type: "link", text, url: link.href }
      : { type: "text", text };
    if (Object.keys(style).length) {
      element.style = style;
    }
    return element;
  });
}

/** Native flat lists; unsupported constructs retain the existing mrkdwn contract. */
export function buildSlackListBlock(ir: MarkdownIR): RichTextBlock | undefined {
  const items = ir.listItems;
  if (
    !items?.length ||
    ir.annotations?.length ||
    /[<>]/u.test(ir.text) ||
    // mrkdwn resolves bare URLs and emoji shortcodes; native text is literal.
    [...ir.text.matchAll(/https?:\/\/|\bwww\.|@|:[\w+-]+:/gu)].some(
      (match) => !ir.links.some((link) => link.start <= match.index && link.end > match.index),
    ) ||
    ir.styles.some(
      (span) =>
        !["bold", "italic", "strikethrough", "code"].includes(span.style) &&
        !span.style.startsWith("heading_"),
    ) ||
    ir.links.some((link) => !/^https?:\/\//u.test(link.href))
  ) {
    return undefined;
  }
  const elements: RichTextBlock["elements"] = [];
  const section = (start: number, end: number): RichTextSection => ({
    type: "rich_text_section",
    elements: renderInline(ir, start, end),
  });
  const trimSeparators = (start: number, end: number) => {
    let contentStart = start;
    let contentEnd = end;
    // Inline code owns its whitespace; only remove surrounding separators.
    const isSeparator = (offset: number) =>
      /\s/u.test(ir.text.charAt(offset)) &&
      !ir.styles.some((span) => span.style === "code" && span.start <= offset && offset < span.end);
    while (contentStart < contentEnd && isSeparator(contentStart)) {
      contentStart++;
    }
    while (contentEnd > contentStart && isSeparator(contentEnd - 1)) {
      contentEnd--;
    }
    return [contentStart, contentEnd] as const;
  };
  const appendProse = (start: number, end: number) => {
    const [contentStart, contentEnd] = trimSeparators(start, end);
    if (contentStart < contentEnd) {
      elements.push(section(contentStart, contentEnd));
    }
  };
  let cursor = 0;
  let listId: number | undefined;
  for (const item of items) {
    const { start, end, listMarker } = item;
    if (
      item.kind !== "bullet" ||
      item.task ||
      item.depth !== 0 ||
      start === undefined ||
      end === undefined ||
      !listMarker
    ) {
      return undefined;
    }
    const [contentStart, contentEnd] = trimSeparators(listMarker.end, end);
    const text = ir.text.slice(contentStart, contentEnd);
    if (!text || text.includes("\n") || /^\[[ xX]\]\s/u.test(text)) {
      return undefined;
    }
    appendProse(cursor, start);
    const entry = section(contentStart, contentEnd);
    const previous = elements.at(-1);
    if (previous?.type === "rich_text_list" && listId === item.listId) {
      previous.elements.push(entry);
    } else {
      elements.push({ type: "rich_text_list", style: "bullet", elements: [entry] });
    }
    cursor = end;
    listId = item.listId;
  }
  appendProse(cursor, ir.text.length);
  return { type: "rich_text", elements };
}
