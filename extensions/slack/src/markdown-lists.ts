import type { KnownBlock, RichTextBlock, RichTextElement, RichTextList } from "@slack/types";
import type { MarkdownIR } from "openclaw/plugin-sdk/text-chunking";
import { SLACK_MAX_BLOCKS } from "./blocks-input.js";
import { SLACK_SECTION_TEXT_MAX } from "./presentation.js";

// Match Slack's inline tokens in parsed item text only. Code and Markdown links
// already have their own spans and take precedence.
const SLACK_INLINE_TOKEN = /<([^<>\n]+)>|:([a-zA-Z0-9_+-]+):/gu;

function isSlackRichTextUrl(url: string): boolean {
  return /^(?:https?:\/\/|slack:\/\/|mailto:|tel:)/iu.test(url);
}

function slackInlineToken(
  body: string,
  style: RichTextElement["style"],
): RichTextElement | undefined {
  const [target = "", label] = body.split("|", 2);
  if (/^@[UW][A-Z0-9]+$/u.test(target)) {
    return { type: "user", user_id: target.slice(1), style };
  }
  if (/^#[CG][A-Z0-9]+$/u.test(target)) {
    return { type: "channel", channel_id: target.slice(1), style };
  }
  if (/^!subteam\^S[A-Z0-9]+$/u.test(target)) {
    return { type: "usergroup", usergroup_id: target.slice("!subteam^".length), style };
  }
  const range = target.slice(1);
  if (target.startsWith("!") && (range === "here" || range === "channel" || range === "everyone")) {
    return { type: "broadcast", range, style };
  }
  if (isSlackRichTextUrl(target)) {
    return { type: "link", url: target, ...(label ? { text: label } : {}), style };
  }
  return undefined;
}

function renderListItem(ir: MarkdownIR, itemStart: number, itemEnd: number): RichTextElement[] {
  const styles = ir.styles.filter(({ start, end }) => start < itemEnd && end > itemStart);
  const links = ir.links.filter(({ start, end }) => start < itemEnd && end > itemStart);
  const boundaries = new Set([itemStart, itemEnd]);
  for (const { start, end } of [...styles, ...links]) {
    boundaries.add(Math.max(start, itemStart));
    boundaries.add(Math.min(end, itemEnd));
  }
  const elements: RichTextElement[] = [];
  let start = itemStart;
  for (const end of [...boundaries].toSorted((a, b) => a - b).slice(1)) {
    const text = ir.text.slice(start, end);
    const style: NonNullable<RichTextElement["style"]> = {};
    for (const span of styles) {
      if (span.start > start || span.end < end) {
        continue;
      }
      switch (span.style) {
        case "bold":
          style.bold = true;
          break;
        case "italic":
          style.italic = true;
          break;
        case "strikethrough":
          style.strike = true;
          break;
        case "underline":
          style.underline = true;
          break;
        case "code":
        case "code_block":
          style.code = true;
          break;
        default:
          break;
      }
    }
    const elementStyle = Object.keys(style).length ? style : undefined;
    const link = links.find((span) => span.start <= start && span.end >= end);
    start = end;
    if (link && !style.code) {
      elements.push(
        isSlackRichTextUrl(link.href)
          ? { type: "link", url: link.href, text, style: elementStyle }
          : { type: "text", text, style: elementStyle },
      );
    } else if (style.code) {
      elements.push({ type: "text", text, style });
    } else {
      let cursor = 0;
      for (const match of text.matchAll(SLACK_INLINE_TOKEN)) {
        const token: RichTextElement | undefined = match[2]
          ? { type: "emoji", name: match[2], style: elementStyle }
          : slackInlineToken(match[1] ?? "", elementStyle);
        if (!token) {
          continue;
        }
        if (cursor < match.index) {
          elements.push({
            type: "text",
            text: text.slice(cursor, match.index),
            style: elementStyle,
          });
        }
        elements.push(token);
        cursor = match.index + match[0].length;
      }
      if (cursor < text.length) {
        elements.push({ type: "text", text: text.slice(cursor), style: elementStyle });
      }
    }
  }
  return elements;
}

export function renderSlackMarkdownLists(
  ir: MarkdownIR,
  renderMrkdwn: (start: number, end: number) => string,
): KnownBlock[] | undefined {
  const items = (ir.listItems ?? [])
    .filter((item) => item.listMarker && item.start !== undefined && item.end !== undefined)
    .toSorted((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const blocks: KnownBlock[] = [];
  let richText: RichTextBlock | undefined;
  let list: RichTextList | undefined;
  let listId: number | undefined;
  let cursor = 0;
  const appendProse = (end: number) => {
    if (!ir.text.slice(cursor, end).trim()) {
      return;
    }
    const text = renderMrkdwn(cursor, end).trim();
    if (text) {
      blocks.push({ type: "section", text: { type: "mrkdwn", text } });
      richText = undefined;
      list = undefined;
    }
  };
  for (const [index, item] of items.entries()) {
    const start = item.start ?? 0;
    const markerEnd = item.listMarker?.end ?? start;
    const end = Math.min(item.end ?? start, items[index + 1]?.start ?? ir.text.length);
    if (markerEnd >= end) {
      continue;
    }
    appendProse(start);
    if (!richText) {
      richText = { type: "rich_text", elements: [] };
      blocks.push(richText);
    }
    if (!list || listId !== item.listId) {
      const indent = item.depth ?? 0;
      const offset =
        item.kind === "ordered"
          ? Number.parseInt(ir.text.slice(item.listMarker?.start, markerEnd), 10) - 1
          : 0;
      list = {
        type: "rich_text_list",
        style: item.kind,
        indent,
        ...(Number.isFinite(offset) && offset > 0 ? { offset } : {}),
        elements: [],
      };
      listId = item.listId;
      richText.elements.push(list);
    }
    const content = ir.text.slice(markerEnd, end);
    const elements = renderListItem(ir, markerEnd, markerEnd + content.trimEnd().length);
    list.elements.push({
      type: "rich_text_section",
      elements: elements.length ? elements : [{ type: "text", text: " " }],
    });
    cursor = end;
  }
  if (blocks.length === 0) {
    return undefined;
  }
  appendProse(ir.text.length);
  return blocks.length > SLACK_MAX_BLOCKS ||
    blocks.some(
      (block) =>
        block.type === "section" && (block.text?.text.length ?? 0) > SLACK_SECTION_TEXT_MAX,
    )
    ? undefined
    : blocks;
}
