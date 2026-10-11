// Feishu plugin module owns how a table mode routes a reply through cards and posts.
import type { MarkdownTableMode } from "openclaw/plugin-sdk/markdown-table-runtime";
import { hasCardMarkdownTable, hasUndrawableCardTable } from "./presentation-card.js";
import { plainReasoningText } from "./reasoning-structure.js";

/**
 * One owner for every question the configured table mode answers: which representation the
 * text takes, which shapes a card cannot draw, and how far a conversion may grow before the
 * message it settles into has to carry it instead.
 */
export function createFeishuTableRouting(params: {
  convertMarkdownTables: (text: string, mode: MarkdownTableMode) => string;
  tableMode: MarkdownTableMode;
  textChunkLimit: number;
}) {
  // answer previews stream raw text, so the preview dedupe compares payload text, while
  // streamed content enters the ownership state (closing record, settlement, delivered
  // finals) and every comparison against a final in this one rendered form. The closing
  // record and the settlement lookup take the answer rather than the reasoning preview.
  // An unmatched off close is the exception, since it posts reasoning and answer
  // combined and records that combined body as a delivered final. Off conversion returns
  // its input, so that key holds the value it held before this change.
  const nativeTables = params.tableMode === "block";
  const postTableMode = nativeTables ? "code" : params.tableMode;
  const renderTables = (value: string): string =>
    nativeTables ? value : params.convertMarkdownTables(value, params.tableMode);
  // off has no card representation, since a card renderer parses the pipes, so text
  // that still carries a table takes the post path. The card renderer's own parser
  // answers what counts as a table, so pipe-less GFM counts and a fenced sample that
  // only looks like one does not.
  const tableNeedsPostPath = (value: string): boolean =>
    params.tableMode === "off" && hasCardMarkdownTable(value);
  // A card draws a native table, but reasoning is blockquoted before it reaches one and a
  // card does not draw a quoted table, so those rows vanish from the preview. A quoted
  // bullet list is not a table at all, so nothing about it is undrawable and the rows
  // survive. The close path takes the same fallback for the same reason.
  // What the card carries is this text wrapped and set beside the answer, so the limit is
  // asked of the message that is actually sent rather than of the conversion alone, which
  // the dispatcher does where both halves are known.
  const previewReasoningText = (value: string): string =>
    nativeTables && hasCardMarkdownTable(value)
      ? params.convertMarkdownTables(value, "bullets")
      : renderTables(value);
  // block keeps its tables raw for a card to draw, so answer text carrying a shape
  // the card renderer is not expected to draw takes the post path instead. A card
  // that cannot draw a table drops those rows from the message rather than
  // degrading them. This asks about the answer alone: reasoning is wrapped in a
  // blockquote before it reaches the card, which is a separate limitation that
  // predates this change.
  const answerTableNeedsPostPath = (value: string): boolean =>
    nativeTables && hasUndrawableCardTable(value);

  // Where a streamed close settles: the card it would write, or the post that replaces it.
  const resolveStreamingCloseRoute = (input: {
    disposition: "closed" | "discarded";
    reasoning: string;
    answer: string;
    authoredAnswer: string;
    combine: (thinking: string, answer: string) => string;
  }) => {
    // `tableNeedsPostPath` only fires in off mode, where the fallback below does not
    // apply, so the routing decision reads the untouched combination.
    const rawText = input.combine(input.reasoning, input.answer);
    // Committing here would put the table in a card just as surely as delivering a
    // final would, so this close drops the card and reuses a matching block
    // receipt or sends the combined text for a final to inherit.
    // Reasoning is blockquoted before it reaches the card, and a card does not draw
    // a blockquoted table, so one that is still raw here loses its rows. The preview
    // asks this question of every mode and gives way to the authored table when its own
    // conversion outgrows the limit, which is exactly the text the close then finds
    // stored, so the close asks the same question rather than only the native one:
    // block degrades to a quote-surviving list and keeps the card the answer earned,
    // and the other modes take their configured shape. What a mode already converted
    // carries no table for this to find, so nothing is converted twice. A projection
    // that outgrows the limit falls to the post path, where the rows stay
    // readable: that path converts for its own target and keeps them as authored when a
    // quoted fence could not survive its cut.
    const plainReasoning = plainReasoningText(input.reasoning);
    const projectedReasoning = hasCardMarkdownTable(plainReasoning)
      ? previewReasoningText(plainReasoning)
      : undefined;
    // The body a card close would write, which is what the limit has to be asked about.
    const cardText =
      projectedReasoning === undefined ? rawText : input.combine(projectedReasoning, input.answer);
    const authoredText = input.combine(input.reasoning, input.authoredAnswer);
    // A close writes the whole projection in one go and cannot cut it into several, so a
    // conversion past the limit the settled answer is held to takes the post path here
    // for the same reason the preview stands down for it. The card carries the reasoning
    // wrapped and set beside the answer, so the limit answers for that whole body rather
    // than for either half: two conversions that each fit it still write a card past it.
    // Text the author wrote long is no conversion's doing and closes the way it always
    // has, which is why the projection has to differ from the authored combination.
    const projectionExceedsLimit =
      cardText !== authoredText && cardText.length > params.textChunkLimit;
    const needsPost =
      input.disposition === "closed" &&
      (tableNeedsPostPath(rawText) ||
        answerTableNeedsPostPath(input.answer) ||
        projectionExceedsLimit);
    return { authoredText, needsPost, text: needsPost ? rawText : cardText };
  };

  return {
    nativeTables,
    postTableMode,
    renderTables,
    previewReasoningText,
    tableNeedsPostPath,
    answerTableNeedsPostPath,
    resolveStreamingCloseRoute,
  };
}
