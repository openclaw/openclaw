import type { MarkdownTableMode } from "openclaw/plugin-sdk/config-contracts";
import { chunkMarkdownTextWithMode, type ChunkMode } from "openclaw/plugin-sdk/reply-chunking";
import {
  FormatCapabilityProfile,
  type MarkdownIR,
  markdownToIRWithMeta,
  renderMarkdownIRChunksWithinLimit,
  renderMarkdownWithMarkers,
  sliceMarkdownIR,
} from "openclaw/plugin-sdk/text-chunking";

const WHATSAPP_FORMAT_CAPABILITIES = FormatCapabilityProfile.define({
  mechanism: "markdown",
  constructs: {
    underline: "strip",
    spoiler: "fallback",
    codeLanguage: "fallback",
    linkLabel: "fallback",
    heading: "fallback",
    taskList: "fallback",
    table: "fallback",
    image: "fallback",
  },
  chunk: { limit: 4_096, unit: "chars" },
});

const WHATSAPP_STYLE_MARKERS = {
  bold: { open: "*", close: "*" },
  italic: { open: "_", close: "_" },
  strikethrough: { open: "~", close: "~" },
  code: { open: "```", close: "```" },
  code_block: { open: "```\n", close: "```" },
} as const;

const WHATSAPP_INDENT_GUARD = "\u2060";
const WHATSAPP_MARKERS = ["*", "_", "~", "`"] as const;

export function markdownToWhatsAppChunks(
  text: string,
  limit: number,
  tableMode: MarkdownTableMode = "bullets",
  chunkMode: ChunkMode = "length",
): string[] {
  if (!text) {
    return [];
  }
  if (!text.trim()) {
    return chunkMarkdownTextWithMode(text, limit, chunkMode);
  }
  // Some outbound callers preserve leading indentation as presentation, while
  // CommonMark consumes it as block indentation. Guard only the parse.
  const guardedIndent = /^[\t ]/u.test(text);
  const placeholders: string[] = [];
  for (const [start, end] of [
    [0xe000, 0xf8ff],
    [0xf0000, 0xffffd],
  ] as const) {
    for (
      let codePoint = start;
      codePoint <= end && placeholders.length < WHATSAPP_MARKERS.length;
      codePoint += 1
    ) {
      const candidate = String.fromCodePoint(codePoint);
      if (!text.includes(candidate)) {
        placeholders.push(candidate);
      }
    }
  }
  if (placeholders.length < WHATSAPP_MARKERS.length) {
    throw new Error("Unable to reserve WhatsApp formatting placeholders");
  }
  const escapedMarkers = WHATSAPP_MARKERS.map((marker, index) => ({
    source: `\\${marker}`,
    placeholder: placeholders[index] ?? "",
  }));
  let protectedText = text;
  for (const { source, placeholder } of escapedMarkers) {
    protectedText = protectedText.replaceAll(source, placeholder);
  }
  const markdown = guardedIndent ? `${WHATSAPP_INDENT_GUARD}${protectedText}` : protectedText;
  const trailingWhitespace = text.match(/\s+$/u)?.[0] ?? "";
  const { ir: parsedIr, hasTables } = markdownToIRWithMeta(markdown, {
    linkify: false,
    autolink: false,
    enableSpoilers: true,
    enableHtmlUnderline: true,
    enableTaskLists: true,
    headingStyle: "rich",
    tableMode: tableMode === "block" ? "code" : tableMode,
    preserveSourceBlockSpacing: true,
  });
  let ir = parsedIr;
  if (guardedIndent && ir.text.startsWith(WHATSAPP_INDENT_GUARD)) {
    ir = sliceMarkdownIR(ir, WHATSAPP_INDENT_GUARD.length, ir.text.length);
  }
  if (!hasTables && trailingWhitespace) {
    ir.text = `${ir.text.trimEnd()}${trailingWhitespace}`;
  }
  const render = (chunk: MarkdownIR) =>
    renderMarkdownWithMarkers(
      chunk,
      {
        styleMarkers: WHATSAPP_STYLE_MARKERS,
        blockquotePrefix: "> ",
        escapeText: (value) => {
          let restored = value;
          for (const { source, placeholder } of escapedMarkers) {
            restored = restored.replaceAll(placeholder, source);
          }
          return restored;
        },
      },
      WHATSAPP_FORMAT_CAPABILITIES,
    );
  function splitWhatsAppIRForChunkMode(): MarkdownIR[] {
    if (chunkMode !== "newline") {
      return [ir];
    }
    const chunkTexts = chunkMarkdownTextWithMode(ir.text, limit, chunkMode);
    const chunks: MarkdownIR[] = [];
    let cursor = 0;
    for (const chunkText of chunkTexts) {
      const start = ir.text.indexOf(chunkText, cursor);
      if (start < 0) {
        return [ir];
      }
      const end = start + chunkText.length;
      chunks.push(sliceMarkdownIR(ir, start, end));
      cursor = end;
    }
    return chunks;
  }

  let chunks =
    ir.styles.length === 0 && ir.links.length === 0
      ? chunkMarkdownTextWithMode(render(ir), limit, chunkMode)
      : splitWhatsAppIRForChunkMode().flatMap((source) =>
          renderMarkdownIRChunksWithinLimit({
            ir: source,
            limit,
            renderChunk: render,
            measureRendered: (value) => value.length,
          }).map((chunk) => chunk.rendered),
        );
  if (chunkMode === "newline") {
    chunks = chunks.map((chunk) => chunk.trimEnd()).filter(Boolean);
  }
  return chunks;
}

export function markdownToWhatsApp(text: string, tableMode: MarkdownTableMode = "bullets"): string {
  return markdownToWhatsAppChunks(text, Number.POSITIVE_INFINITY, tableMode).join("");
}
