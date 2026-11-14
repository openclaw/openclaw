import {
  applyMarkdownTextEdits,
  renderMarkdownWithMarkers,
  type MarkdownStyle,
  type MarkdownStyleSpan,
} from "openclaw/plugin-sdk/text-chunking";
import { normalizeE164 } from "openclaw/plugin-sdk/text-utility-runtime";
import type { SignalTextStyleRange } from "../format.js";
import type { SignalDataMessage, SignalMention } from "./event-handler.types.js";

const OBJECT_REPLACEMENT = "\uFFFC";

function isValidMention(mention: SignalMention | null | undefined): mention is SignalMention {
  if (!mention) {
    return false;
  }
  if (!(mention.uuid || mention.number)) {
    return false;
  }
  if (typeof mention.start !== "number" || Number.isNaN(mention.start)) {
    return false;
  }
  if (typeof mention.length !== "number" || Number.isNaN(mention.length)) {
    return false;
  }
  return mention.length > 0;
}

function clampBounds(start: number, length: number, textLength: number) {
  const safeStart = Math.max(0, Math.trunc(start));
  const safeLength = Math.max(0, Math.trunc(length));
  const safeEnd = Math.min(textLength, safeStart + safeLength);
  return { start: safeStart, end: safeEnd };
}

function isValidStructuredMention(
  message: string,
  mention: SignalMention | null | undefined,
): mention is SignalMention {
  if (!mention || !(mention.uuid || mention.number)) {
    return false;
  }
  const { start, length } = mention;
  if (typeof start !== "number" || typeof length !== "number") {
    return false;
  }
  return (
    Number.isInteger(start) &&
    Number.isInteger(length) &&
    start >= 0 &&
    length > 0 &&
    start + length <= message.length
  );
}

function normalizeAccountPhone(account?: string | null) {
  const trimmed = account?.trim();
  return trimmed ? normalizeE164(trimmed) : undefined;
}

export function resolveSignalMentionFacts(
  identity: {
    account?: string | null;
    accountUuid?: string | null;
  },
  message: string,
  mentions?: SignalMention[] | null,
) {
  const validMentions = (mentions ?? []).filter((mention) =>
    isValidStructuredMention(message, mention),
  );
  const botUuid = identity.accountUuid?.trim();
  const botPhone = normalizeAccountPhone(identity.account);
  const canDetectBotMention = Boolean(botUuid || botPhone);
  const mentionsBot = validMentions.some((mention) => {
    const mentionUuid = mention.uuid?.trim();
    if (botUuid && mentionUuid === botUuid) {
      return true;
    }
    const mentionNumber = mention.number?.trim();
    return Boolean(botPhone && mentionNumber && normalizeE164(mentionNumber) === botPhone);
  });

  return {
    canDetectBotMention,
    hasAnyMention: validMentions.length > 0,
    mentionsBot,
  };
}

const SIGNAL_STYLE_NAMES = new Map<SignalTextStyleRange["style"], MarkdownStyle>([
  ["BOLD", "bold"],
  ["ITALIC", "italic"],
  ["STRIKETHROUGH", "strikethrough"],
  ["MONOSPACE", "code"],
  ["SPOILER", "spoiler"],
]);

/**
 * Renders mentions as `@id` and returns the text twice: plain for command matching and quotes,
 * and with Signal's text styles as Markdown for the agent, so a struck-out word stays struck out.
 */
export function renderSignalText(dataMessage?: SignalDataMessage | null) {
  const message = dataMessage?.message ?? "";
  let styles: MarkdownStyleSpan[] = (dataMessage?.textStyles ?? []).flatMap((range) => {
    const style = SIGNAL_STYLE_NAMES.get(range.style);
    const end = range.start + range.length;
    const valid =
      Number.isInteger(range.start) &&
      Number.isInteger(range.length) &&
      range.start >= 0 &&
      range.length > 0 &&
      end <= message.length;
    return style && valid ? [{ start: range.start, end, style }] : [];
  });
  let normalized = message;
  const candidates = (dataMessage?.mentions ?? [])
    .filter(isValidMention)
    .toSorted((a, b) => b.start! - a.start!);

  for (const mention of candidates) {
    const identifier = mention.uuid ?? mention.number;
    if (!identifier) {
      continue;
    }

    const { start, end } = clampBounds(mention.start!, mention.length!, normalized.length);
    if (start >= end) {
      continue;
    }
    const slice = normalized.slice(start, end);

    if (!slice.includes(OBJECT_REPLACEMENT)) {
      continue;
    }

    // Mentions and styles share the original UTF-16 offsets, so move the styles with each edit.
    const edited = applyMarkdownTextEdits(normalized, [{ start, end, text: `@${identifier}` }]);
    normalized = edited.text;
    styles = styles.map((span) => ({
      ...span,
      start: edited.mapOffset(span.start),
      end: edited.mapOffset(span.end),
    }));
  }

  // Native ranges can overlap or touch without a visible style transition.
  const mergedStyles: MarkdownStyleSpan[] = [];
  for (const span of styles.toSorted(
    (a, b) => a.style.localeCompare(b.style) || a.start - b.start,
  )) {
    const previous = mergedStyles.at(-1);
    if (previous?.style === span.style && span.start <= previous.end) {
      previous.end = Math.max(previous.end, span.end);
    } else {
      mergedStyles.push({ ...span });
    }
  }
  styles = mergedStyles;

  // Markdown emphasis cannot cross paragraphs or reopen before whitespace.
  const paragraphBoundaries = Array.from(
    normalized.matchAll(/\r?\n[ \t]*\r?\n/g),
    (match) => match.index + match[0].length,
  );
  const emphasis = styles.filter((span) => span.style !== "code");
  const markdownStyles = emphasis.flatMap((span) => {
    const boundaries = [
      span.start,
      ...paragraphBoundaries.filter((offset) => span.start < offset && offset < span.end),
      ...emphasis
        .filter(
          (other) => other.start < span.start && other.end > span.start && other.end < span.end,
        )
        .map((other) => other.end),
      span.end,
    ].toSorted((a, b) => a - b);
    return boundaries.slice(1).flatMap((end, index) => {
      const start = boundaries[index]!;
      const content = normalized.slice(start, end);
      const trimmed = content.trim();
      if (!trimmed) {
        return [];
      }
      const trimmedStart = start + content.length - content.trimStart().length;
      return [{ ...span, start: trimmedStart, end: trimmedStart + trimmed.length }];
    });
  });

  // Code is literal in Markdown, so put its fences into the text *before*
  // surrounding emphasis. Split at emphasis boundaries to preserve combinations
  // even when only part of a monospace range is bold, italic, or struck through.
  const codeBoundaries = [
    ...new Set(
      styles
        .flatMap((span) => (span.style === "code" ? [span.start, span.end] : []))
        .concat(markdownStyles.flatMap((span) => [span.start, span.end])),
    ),
  ].toSorted((a, b) => a - b);
  const codeEdits = codeBoundaries.slice(1).flatMap((end, index) => {
    const start = codeBoundaries[index]!;
    if (!styles.some((span) => span.style === "code" && span.start <= start && span.end >= end)) {
      return [];
    }
    // Inline code folds line breaks into spaces; fence each line independently.
    const text = normalized
      .slice(start, end)
      .split(/(\r?\n)/)
      .map((content) => {
        if (!content || /^\r?\n$/.test(content)) {
          return content;
        }
        let longestBacktickRun = 0;
        for (const match of content.matchAll(/`+/g)) {
          longestBacktickRun = Math.max(longestBacktickRun, match[0].length);
        }
        const fence = "`".repeat(longestBacktickRun + 1);
        const padding = /^`|`$|^ .* $/s.test(content) && content.trim() ? " " : "";
        return `${fence}${padding}${content}${padding}${fence}`;
      })
      .join("");
    return [{ start, end, text }];
  });
  // Escape source punctuation, not the code fences we generated. Unstyled messages
  // retain their existing Markdown behavior; native ranges define literal text.
  const literalEdits = styles.length
    ? Array.from(normalized.matchAll(/[\\`*_{}[\]()#+\-.!|>~<&]/g))
        .filter(
          (match) => !codeEdits.some(({ start, end }) => start <= match.index && match.index < end),
        )
        .map((match) => ({ start: match.index, end: match.index + 1, text: `\\${match[0]}` }))
    : [];
  const edited = applyMarkdownTextEdits(normalized, [...codeEdits, ...literalEdits]);
  const formattedText = renderMarkdownWithMarkers(
    {
      text: edited.text,
      styles: markdownStyles.map((span) => ({
        style: span.style,
        start: edited.mapOffset(span.start),
        end: edited.mapOffset(span.end),
      })),
      links: [],
    },
    {
      escapeText: (text) => text,
      styleMarkers: {
        bold: { open: "**", close: "**" },
        italic: { open: "*", close: "*" },
        strikethrough: { open: "~~", close: "~~" },
        spoiler: { open: "||", close: "||" },
      },
    },
  );
  return { plainText: normalized.trim(), formattedText: formattedText.trim() };
}
