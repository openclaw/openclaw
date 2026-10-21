import { markdownToIR, tokenizeHtmlTags } from "openclaw/plugin-sdk/text-chunking";
import { decodeTelegramHtmlEntities, isTelegramRichLineBreakStructuralTag } from "./format-html.js";

export const TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX = "<code>Assistant:</code> ";

type TelegramHtmlVisibleProjection = {
  text: string;
  excludedRanges: Array<{ start: number; end: number }>;
};

function telegramProjectionHasRoleHeader(projection: TelegramHtmlVisibleProjection): boolean {
  // Header delimiters must be literal or entity-encoded before Markdown parsing.
  if (
    !projection.text.includes("[") &&
    !projection.text.includes("<") &&
    !projection.text.includes("&")
  ) {
    return false;
  }
  let masked = "";
  let cursor = 0;
  for (const range of projection.excludedRanges) {
    masked += projection.text.slice(cursor, range.start);
    masked += projection.text
      .slice(range.start, range.end)
      .replace(/[^\n]+/g, (line) =>
        line.trim() ? `x${" ".repeat(line.length - 1)}` : " ".repeat(line.length),
      );
    cursor = range.end;
  }
  return Boolean(
    markdownToIR(masked + projection.text.slice(cursor), {
      assistantTranscriptRoleHeaders: true,
      autolink: false,
      blockquotePrefix: "",
      headingStyle: "none",
      linkify: false,
      tableMode: "off",
    }).annotations?.some((annotation) => annotation.type === "assistant_transcript_role"),
  );
}

function projectTelegramHtmlVisibleText(html: string): TelegramHtmlVisibleProjection {
  const projection: TelegramHtmlVisibleProjection = { text: "", excludedRanges: [] };
  const depths = { code: 0, pre: 0 };
  const append = (value: string) => {
    if (!value) {
      return;
    }
    const start = projection.text.length;
    projection.text += value;
    if (depths.code === 0 && depths.pre === 0) {
      return;
    }
    const previous = projection.excludedRanges.at(-1);
    if (previous?.end === start) {
      previous.end = projection.text.length;
    } else {
      projection.excludedRanges.push({ start, end: projection.text.length });
    }
  };
  let lastIndex = 0;

  for (const tag of tokenizeHtmlTags(html)) {
    append(decodeTelegramHtmlEntities(html.slice(lastIndex, tag.start)));

    if (
      isTelegramRichLineBreakStructuralTag(tag.raw, tag.name) &&
      projection.text &&
      !projection.text.endsWith("\n")
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
  return projection;
}

export function protectTelegramAssistantTranscriptRoleHeaders(html: string): string {
  if (html.startsWith(TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX)) {
    return html;
  }
  if (!telegramProjectionHasRoleHeader(projectTelegramHtmlVisibleText(html))) {
    return html;
  }
  // Supported raw HTML is promoted after Markdown parsing and can reveal hidden text.
  return `${TELEGRAM_ASSISTANT_TRANSCRIPT_PREFIX}${html}`;
}
