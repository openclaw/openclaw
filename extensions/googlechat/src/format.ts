import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import {
  FormatCapabilityProfile,
  markdownToIR,
  renderMarkdownIRChunksWithinLimit,
  renderMarkdownWithMarkers,
  sanitizeAssistantVisibleText,
} from "openclaw/plugin-sdk/text-chunking";

export const GOOGLE_CHAT_FORMAT_PROFILE = FormatCapabilityProfile.define({
  mechanism: "markdown",
  constructs: {
    underline: "fallback",
    spoiler: "fallback",
    codeLanguage: "fallback",
    heading: "fallback",
    orderedList: "fallback",
    taskList: "fallback",
    table: "fallback",
    image: "fallback",
    mention: "strip",
  },
  chunk: { limit: 32_000, unit: "bytes" },
});

const GOOGLE_CHAT_LITERAL_FALLBACKS = new Map([
  ["*", "＊"],
  ["_", "＿"],
  ["~", "～"],
  ["`", "｀"],
  ["<", "＜"],
  [">", "＞"],
  ["\\", "＼"],
  ["-", "－"],
  ["|", "｜"],
]);

/** Removes unsafe HTML and internal scaffolding while retaining source Markdown for chunking. */
export function sanitizeGoogleChatText(text: string): string {
  return sanitizeForPlainText(sanitizeAssistantVisibleText(text), {
    style: "markdown",
  });
}

/** Renders CommonMark into byte-bounded Google Chat app-message chunks. */
export function formatGoogleChatTextChunks(
  text: string,
  limit = GOOGLE_CHAT_FORMAT_PROFILE.chunk.limit,
): string[] {
  const sanitized = sanitizeGoogleChatText(text);
  let ir = markdownToIR(sanitized, {
    enableSpoilers: true,
    enableTaskLists: true,
    headingStyle: "rich",
    tableMode: "bullets",
  });
  {
    let codeText = ir.text;
    const styles = ir.styles.filter((span) => {
      const content = ir.text.slice(span.start, span.end);
      const unsafe =
        (span.style === "code" && content.includes("`")) ||
        (span.style === "code_block" && content.includes("```"));
      if (unsafe) {
        const replacement = content
          .split("")
          .map((character) => GOOGLE_CHAT_LITERAL_FALLBACKS.get(character) ?? character)
          .join("");
        codeText = `${codeText.slice(0, span.start)}${replacement}${codeText.slice(span.end)}`;
      }
      return !unsafe;
    });
    ir = styles.length === ir.styles.length ? ir : { ...ir, styles, text: codeText };
  }
  {
    const decodedText = ir.text.replace(
      /<(?:users|customEmojis)\/[^<>\s]+>/giu,
      (match) => `＜${match.slice(1, -1)}＞`,
    );
    ir = decodedText === ir.text ? ir : { ...ir, text: decodedText };
  }
  {
    const characters = ir.links.length > 0 ? ir.text.split("") : [];
    let changed = false;
    for (const link of ir.links) {
      const label = ir.text.slice(link.start, link.end);
      const comparableHref = link.href.startsWith("mailto:")
        ? link.href.slice("mailto:".length)
        : link.href;
      if (label === link.href || label === comparableHref) {
        continue;
      }
      for (let index = link.start; index < link.end; index += 1) {
        const character = characters[index] ?? "";
        const fallback = GOOGLE_CHAT_LITERAL_FALLBACKS.get(character);
        if (fallback && /[<>|*_~`]/u.test(character)) {
          characters[index] = fallback;
          changed = true;
        }
      }
    }
    ir = changed ? { ...ir, text: characters.join("") } : ir;
  }
  {
    const codeRanges = ir.styles.filter(
      (span) => span.style === "code" || span.style === "code_block",
    );
    const inCode = (index: number) =>
      codeRanges.some((span) => index >= span.start && index < span.end);
    const inLink = (index: number) =>
      ir.links.some((span) => index >= span.start && index < span.end);
    const styleDelimiter = new Map([
      ["~", "strikethrough"],
      ["_", "italic"],
      ["*", "bold"],
      ["`", "code"],
    ]);
    const characters = ir.text.split("");
    let lineStart = 0;
    while (lineStart < characters.length) {
      const nextNewline = characters.indexOf("\n", lineStart);
      const lineEnd = nextNewline < 0 ? characters.length : nextNewline;
      for (const delimiter of ["~", "_", "*", "`"]) {
        const indexes: number[] = [];
        for (let index = lineStart; index < lineEnd; index += 1) {
          if (characters[index] === delimiter && !inCode(index) && !inLink(index)) {
            indexes.push(index);
          }
        }
        if (indexes.length === 0) {
          continue;
        }
        const renderedStyle = styleDelimiter.get(delimiter);
        const lineAddsDelimiter = ir.styles.some(
          (span) => span.style === renderedStyle && span.start < lineEnd && span.end > lineStart,
        );
        if (indexes.length >= 2 || lineAddsDelimiter) {
          for (const index of indexes) {
            characters[index] = GOOGLE_CHAT_LITERAL_FALLBACKS.get(delimiter) ?? delimiter;
          }
        }
      }
      let firstTextIndex = lineStart;
      while (firstTextIndex < lineEnd && characters[firstTextIndex] === " ") {
        firstTextIndex += 1;
      }
      if (!inCode(firstTextIndex)) {
        const character = characters[firstTextIndex];
        const isListMarker =
          (character === "*" || character === "-") && characters[firstTextIndex + 1] === " ";
        if (isListMarker || character === ">") {
          characters[firstTextIndex] = GOOGLE_CHAT_LITERAL_FALLBACKS.get(character) ?? character;
        }
      }
      const line = characters.slice(lineStart, lineEnd).join("");
      for (const match of line.matchAll(/<[^<>\n]*\|[^<>\n]*>/gu)) {
        const open = lineStart + (match.index ?? 0);
        const close = open + match[0].length - 1;
        if (!inCode(open) && !inCode(close) && !inLink(open) && !inLink(close)) {
          characters[open] = "＜";
          characters[close] = "＞";
        }
      }
      lineStart = lineEnd + 1;
    }
    const literalText = characters.join("");
    ir = literalText === ir.text ? ir : { ...ir, text: literalText };
  }
  const markerText = ir.text;
  let candidate = 0;
  const rangeSize = 0x1900;
  const nextMarker = () => {
    while (true) {
      const marker = String.fromCharCode(
        0xe000 + Math.floor(candidate / rangeSize),
        0xe000 + (candidate % rangeSize),
      );
      candidate += 1;
      if (!markerText.includes(marker)) {
        return marker;
      }
    }
  };
  const markers = {
    list: nextMarker(),
    blockquoteOpen: nextMarker(),
    blockquoteClose: nextMarker(),
  };
  {
    const markerToken = markers.list;
    let characters: string[] | undefined;
    for (const item of ir.listItems ?? []) {
      const marker = item.listMarker;
      if (
        item.kind !== "bullet" ||
        !marker ||
        marker.end !== marker.start + 2 ||
        ir.text[marker.start] !== "•" ||
        ir.text[marker.start + 1] !== " "
      ) {
        continue;
      }
      characters ??= ir.text.split("");
      characters[marker.start] = markerToken[0] ?? "";
      characters[marker.start + 1] = markerToken[1] ?? "";
    }
    ir = characters ? { ...ir, text: characters.join("") } : ir;
  }
  return renderMarkdownIRChunksWithinLimit<string>({
    ir,
    limit: Math.min(limit, GOOGLE_CHAT_FORMAT_PROFILE.chunk.limit),
    measureRendered: (rendered: string) => Buffer.byteLength(rendered, "utf8"),
    renderChunk: (chunkIr) => {
      const rendered = renderMarkdownWithMarkers(
        chunkIr,
        {
          styleMarkers: {
            bold: { open: "*", close: "*" },
            italic: { open: "_", close: "_" },
            strikethrough: { open: "~", close: "~" },
            code: { open: "`", close: "`" },
            code_block: { open: "```\n", close: "```" },
            blockquote: { open: markers.blockquoteOpen, close: markers.blockquoteClose },
          },
          escapeText: (value) => value,
          buildLink: (link, value, context) => {
            if (context.origin === "linkify") {
              return null;
            }
            const href = link.href.trim();
            const label = value.slice(link.start, link.end);
            if (!href || !label) {
              return null;
            }
            const labelHasStyles = chunkIr.styles.some(
              (span) => span.start < link.end && span.end > link.start,
            );
            return /[<>|]/u.test(href) || /[<>|*_~`]/u.test(label) || labelHasStyles
              ? { start: link.end, end: link.end, open: "", close: ` (${href})` }
              : { start: link.start, end: link.end, open: `<${href}|`, close: ">" };
          },
        },
        GOOGLE_CHAT_FORMAT_PROFILE,
      );
      let depth = 0;
      let lineStart = true;
      let blockquoteText = "";
      for (let index = 0; index < rendered.length; index += 1) {
        if (rendered.startsWith(markers.blockquoteOpen, index)) {
          depth += 1;
          index += markers.blockquoteOpen.length - 1;
          continue;
        }
        if (rendered.startsWith(markers.blockquoteClose, index)) {
          depth = Math.max(0, depth - 1);
          index += markers.blockquoteClose.length - 1;
          continue;
        }
        const character = rendered[index] ?? "";
        if (lineStart && depth > 0) {
          blockquoteText += "> ".repeat(depth);
        }
        blockquoteText += character;
        lineStart = character === "\n";
      }
      const markerToken = markers.list;
      return blockquoteText
        .split("\n")
        .map((line) => {
          const markerIndex = line.indexOf(markerToken);
          if (markerIndex < 0) {
            return line;
          }
          const prefix = line.slice(0, markerIndex);
          const quote = /^(?:> )*/u.exec(prefix)?.[0] ?? "";
          const indent = prefix.slice(quote.length);
          return `${quote}${" ".repeat(indent.length * 2)}* ${line.slice(
            markerIndex + markerToken.length,
          )}`;
        })
        .join("\n");
    },
  }).map((chunk) => chunk.rendered);
}
