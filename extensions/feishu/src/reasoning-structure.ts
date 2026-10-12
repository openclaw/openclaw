// Feishu plugin module keeps streamed and delivered reasoning readable once a table mode has
// produced structure inside it.
import { formatReasoningMessage } from "openclaw/plugin-sdk/agent-runtime";

// A line the renderer has to recognize as structure. A table row is any line
// carrying a cell separator, not only one that opens with a pipe, because the
// shapes this change taught the card parser include pipe-less, leading-pipe-only
// and trailing-pipe-only tables, and a blockquoted table carries its prefix first.
// Erring toward leaving a line plain costs an italic; erring the other way
// destroys a delimiter row and with it the table.
// A quoted table keeps its prefix through conversion, so the fence and the list marker
// the mode produces arrive behind one, and a pattern anchored at the line start reads
// them as prose and underscores them away.
const reasoningFenceLine = /^\s*(?:>\s*)*```/u;
const isReasoningStructureLine = (line: string): boolean =>
  reasoningFenceLine.test(line) ||
  line.includes("|") ||
  /^\s*(?:>\s*)*(?:[-*+\u2022]\s|\d+[.)]\s)/u.test(line) ||
  /^\s*>?\s*:?-{3,}:?\s*$/u.test(line);

// The shared formatter wraps every non-empty line in underscores, which suits prose
// and destroys every shape the table mode produces. Underscores inside a fence are
// literal, an underscored delimiter row is no longer a table, and an underscored
// marker is no longer a list item. Italicize prose only and leave structure alone.
// Text with no structure keeps going through the shared formatter untouched, and the
// plain label stays so existing detection keeps working.
export function formatReasoningPreservingStructure(text: string): string {
  const trimmed = text.trim();
  const lines = trimmed.split("\n");
  if (!trimmed || !lines.some(isReasoningStructureLine)) {
    return formatReasoningMessage(text);
  }
  let insideFence = false;
  const formatted = lines.map((line) => {
    if (reasoningFenceLine.test(line)) {
      insideFence = !insideFence;
      return line;
    }
    return insideFence || !line || isReasoningStructureLine(line) ? line : `_${line}_`;
  });
  return `Thinking\n\n${formatted.join("\n")}`;
}

// The reasoning stream stores its text already italicised, so the shape a card
// finally sees is this stripped form rather than what is held. Anything asking what
// the card will draw has to ask about this.
export const plainReasoningText = (thinking: string): string =>
  thinking.replace(/^(?:Reasoning:|Thinking\.{0,3})\s*/u, "").replace(/^_(.*)_$/gm, "$1");
