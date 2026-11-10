import { markdownToIR, tokenizeHtmlTags } from "openclaw/plugin-sdk/text-chunking";
import { decodeTelegramHtmlEntities, isTelegramRichLineBreakStructuralTag } from "./format-html.js";

export const TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX = "<code>Assistant:</code> ";

export function protectTelegramAssistantTranscriptRoleHeaders(html: string): string {
  if (html.startsWith(TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX)) {
    return html;
  }
  let visibleText = "";
  const excludedRanges: Array<{ start: number; end: number }> = [];
  const depths = { code: 0, pre: 0 };
  const append = (value: string) => {
    if (!value) {
      return;
    }
    const start = visibleText.length;
    visibleText += value;
    if (depths.code === 0 && depths.pre === 0) {
      return;
    }
    const previous = excludedRanges.at(-1);
    if (previous?.end === start) {
      previous.end = visibleText.length;
    } else {
      excludedRanges.push({ start, end: visibleText.length });
    }
  };
  let lastIndex = 0;

  for (const tag of tokenizeHtmlTags(html)) {
    append(decodeTelegramHtmlEntities(html.slice(lastIndex, tag.start)));

    if (
      isTelegramRichLineBreakStructuralTag(tag.raw, tag.name) &&
      visibleText &&
      !visibleText.endsWith("\n")
    ) {
      append("\n");
    }
    if (tag.name === "br" && !tag.closing) {
      append("\n");
    }
    if (!tag.selfClosing && (tag.name === "code" || tag.name === "pre")) {
      depths[tag.name] = tag.closing ? Math.max(0, depths[tag.name] - 1) : depths[tag.name] + 1;
    }
    lastIndex = tag.end;
  }
  append(decodeTelegramHtmlEntities(html.slice(lastIndex)));

  // Header delimiters must be literal or entity-encoded before Markdown parsing.
  if (!visibleText.includes("[") && !visibleText.includes("<") && !visibleText.includes("&")) {
    return html;
  }
  let masked = "";
  let cursor = 0;
  for (const range of excludedRanges) {
    masked += visibleText.slice(cursor, range.start);
    masked += visibleText
      .slice(range.start, range.end)
      .replace(/[^\n]+/g, (line) =>
        line.trim() ? `x${" ".repeat(line.length - 1)}` : " ".repeat(line.length),
      );
    cursor = range.end;
  }
  if (
    !markdownToIR(masked + visibleText.slice(cursor), {
      assistantTranscriptRoleHeaders: true,
      autolink: false,
      blockquotePrefix: "",
      headingStyle: "none",
      linkify: false,
      tableMode: "off",
    }).annotations?.some((annotation) => annotation.type === "assistant_transcript_role")
  ) {
    return html;
  }
  // Supported raw HTML is promoted after Markdown parsing and can reveal hidden text.
  return `${TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX}${html}`;
}
