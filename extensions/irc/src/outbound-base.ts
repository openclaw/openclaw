import { sanitizeForPlainText } from "openclaw/plugin-sdk/channel-outbound";
import { resolveMarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import {
  chunkTextForOutbound,
  convertMarkdownTables,
  findCodeRegions,
  sanitizeAssistantVisibleText,
  stripMarkdown,
} from "openclaw/plugin-sdk/text-chunking";
import type { CoreConfig } from "./types.js";

export function sanitizeIrcAssistantText(text: string): string {
  return sanitizeForPlainText(sanitizeAssistantVisibleText(text));
}

/** Inline-code backtick run left open by the previous streamed fragment (0 = none). */
export type IrcInlineCodeCarry = { ticks: number };

/**
 * Block streaming can split a reply inside an inline code span, so neither half
 * parses on its own. Re-open the span the previous fragment left, and (for block
 * fragments only, `opensCarry`) close one this fragment leaves dangling, so code
 * content stays literal in both halves. A whole reply never opens a carry.
 */
function keepInlineCodeLiteral(
  source: string,
  carry: IrcInlineCodeCarry,
  opensCarry: boolean,
): string {
  let text = source;
  if (carry.ticks > 0) {
    const ticks = "`".repeat(carry.ticks);
    const reopened = `${ticks}${text}`;
    if (findCodeRegions(reopened).some((region) => region.start === 0 && !region.block)) {
      text = reopened;
    } else if (!/\n[\t ]*\n/.test(text)) {
      return `${ticks}${text}${ticks}`;
    }
  }
  carry.ticks = 0;
  if (!opensCarry) {
    return text;
  }
  const regions = findCodeRegions(text);
  // A span cannot cross a blank line, so only the last paragraph can stay open.
  const paragraphBreak = [...text.matchAll(/\n[\t ]*\n/g)].at(-1);
  const tailStart = paragraphBreak ? paragraphBreak.index + paragraphBreak[0].length : 0;
  let dangling: string | undefined;
  for (const run of text.matchAll(/`+/g)) {
    const owned = regions.some((region) => run.index >= region.start && run.index < region.end);
    const next = text[run.index + run[0].length];
    // An opener hugs its content; a lone backtick between spaces is literal text.
    if (
      !owned &&
      run.index >= tailStart &&
      text[run.index - 1] !== "\\" &&
      !/\s/.test(next ?? "")
    ) {
      dangling = run[0];
    }
  }
  carry.ticks = dangling?.length ?? 0;
  return dangling ? `${text}${dangling}` : text;
}

/**
 * Whether a raw fragment opens after a blank line. The chunker keeps that
 * separator at the start of the next fragment, and inline code cannot cross it.
 */
export function startsAfterParagraphBreak(rawText: string): boolean {
  return /\n[\t ]*\n/.test(rawText.slice(0, rawText.length - rawText.trimStart().length));
}

/**
 * IRC has no rich text, so direct sends and inbound replies render Markdown to
 * plain text with this one helper. Render the complete source before splitting:
 * fragment parsing loses code, link, and table context. Streamed fragments pass
 * a per-reply `carry` so inline code split across fragments stays literal; only
 * block fragments (`opensCarry`) can leave a span open for the next one.
 */
export function renderIrcPlainText(
  text: string,
  params: {
    cfg: CoreConfig;
    accountId?: string;
    carry?: IrcInlineCodeCarry;
    opensCarry?: boolean;
  },
): string {
  const tableMode = resolveMarkdownTableMode({
    cfg: params.cfg,
    channel: "irc",
    accountId: params.accountId,
  });
  const source = convertMarkdownTables(text.trim(), tableMode);
  const { carry, opensCarry = false } = params;
  return stripMarkdown(carry ? keepInlineCodeLiteral(source, carry, opensCarry) : source);
}

export const ircOutboundBaseAdapter = {
  deliveryMode: "direct" as const,
  chunker: chunkTextForOutbound,
  chunkerMode: "markdown" as const,
  textChunkLimit: 350,
  // IRC's plain-text pass does not remove assistant scaffolding. Run the
  // canonical delivery sanitizer first so internal tool traces are dropped
  // before channel formatting.
  sanitizeText: ({ text }: { text: string }) => sanitizeIrcAssistantText(text),
};
