import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";

/**
 * Streamed reasoning rendered as native task cards: fixed-size segments, one
 * task row each, so the whole thought stays readable in the plan block
 * instead of one compacted narration line.
 */

/**
 * Reasoning characters per card. With the lane prefix this stays under the
 * 256-character limit Slack documents per `task_update` title
 * (https://docs.slack.dev/reference/methods/chat.appendStream/).
 */
const SLACK_REASONING_CARD_CHARS = 240;
// Slack's plan block renders at most 50 tasks
// (https://docs.slack.dev/reference/block-kit/blocks/plan-block/). Tool rows,
// the receipt row and attention rows share that budget with reasoning cards.
const SLACK_REASONING_CARD_MAX = 47;
const SLACK_REASONING_CARD_MIN = 8;
const SLACK_REASONING_CARD_LINE_ID_PREFIX = "reasoning:";
const SLACK_REASONING_TAIL_CARD_LINE_ID = `${SLACK_REASONING_CARD_LINE_ID_PREFIX}tail`;
const SLACK_REASONING_CARD_TEXT_PREFIX = "🧠 ";

export type SlackReasoningCardLine = ChannelProgressDraftLine & { id: string };

export type SlackReasoningCardState = {
  /** Segments closed by a tool call or the end of a reasoning phase. */
  sealed: string[];
  /** Reasoning text of the phase still streaming. */
  open: string;
  toolCalls: number;
  /** Segment cards already pushed; Slack cannot remove rows, so ids never shrink. */
  cardsEmitted: number;
};

export function createSlackReasoningCardState(): SlackReasoningCardState {
  return { sealed: [], open: "", toolCalls: 0, cardsEmitted: 0 };
}

export function isSlackReasoningCardLine(line: Pick<ChannelProgressDraftLine, "id">): boolean {
  return line.id?.startsWith(SLACK_REASONING_CARD_LINE_ID_PREFIX) === true;
}

function normalizeReasoningText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Splits reasoning into segments of at most `maxChars` code points, cutting at
 * the last space in the second half of each window. Cuts depend only on the
 * text before them, so segments already shown never change as the text grows.
 */
export function segmentReasoningText(
  text: string,
  maxChars = SLACK_REASONING_CARD_CHARS,
): string[] {
  const chars = Array.from(normalizeReasoningText(text));
  if (chars.length === 0) {
    return [];
  }
  const segments: string[] = [];
  let start = 0;
  while (chars.length - start > maxChars) {
    let cut = start + maxChars;
    for (let index = start + maxChars; index > start + Math.floor(maxChars / 2); index -= 1) {
      if (chars[index] === " ") {
        cut = index;
        break;
      }
    }
    segments.push(chars.slice(start, cut).join("").trim());
    start = cut;
    // Windows start on a word so a boundary cut cannot shift the next segment by one.
    while (chars[start] === " ") {
      start += 1;
    }
  }
  segments.push(chars.slice(start).join("").trim());
  return segments.filter((segment) => segment.length > 0);
}

/** Latest `maxChars` of overflow text, cut at a word boundary and marked as a tail. */
export function tailReasoningSnippet(text: string, maxChars = SLACK_REASONING_CARD_CHARS): string {
  const normalized = normalizeReasoningText(text);
  const chars = Array.from(normalized);
  if (chars.length <= maxChars) {
    return normalized;
  }
  const tail = chars.slice(-(maxChars - 1)).join("");
  const boundary = tail.indexOf(" ");
  const body =
    boundary >= 0 && boundary < Math.floor(maxChars * 0.4)
      ? tail.slice(boundary + 1).trimStart()
      : tail;
  return `…${body}`;
}

function reasoningCardLine(id: string, text: string, done: boolean): SlackReasoningCardLine {
  return {
    id,
    kind: "item",
    text: `${SLACK_REASONING_CARD_TEXT_PREFIX}${text}`,
    label: "Reasoning",
    prefix: false,
    ...(done ? { status: "completed" } : {}),
  };
}

/**
 * Card rows for the current reasoning state. Every segment but the newest is
 * complete. Past the card budget the remaining text rolls through one tail
 * card so a long think cannot exhaust the plan block.
 */
export function planSlackReasoningCards(state: SlackReasoningCardState): {
  lines: SlackReasoningCardLine[];
  cardsEmitted: number;
} {
  const openSegments = segmentReasoningText(state.open);
  const segments = [...state.sealed, ...openSegments];
  if (segments.length === 0) {
    return { lines: [], cardsEmitted: state.cardsEmitted };
  }
  const openIndex = openSegments.length > 0 ? segments.length - 1 : -1;
  const budget = Math.max(
    state.cardsEmitted,
    SLACK_REASONING_CARD_MIN,
    SLACK_REASONING_CARD_MAX - state.toolCalls,
  );
  const cardCount = Math.min(segments.length, budget);
  const lines = segments
    .slice(0, cardCount)
    .map((segment, index) =>
      reasoningCardLine(
        `${SLACK_REASONING_CARD_LINE_ID_PREFIX}${index + 1}`,
        segment,
        index !== openIndex,
      ),
    );
  if (segments.length > cardCount) {
    lines.push(
      reasoningCardLine(
        SLACK_REASONING_TAIL_CARD_LINE_ID,
        tailReasoningSnippet(segments.slice(cardCount).join(" ")),
        openIndex < cardCount,
      ),
    );
  }
  return { lines, cardsEmitted: Math.max(state.cardsEmitted, cardCount) };
}

export function formatReasoningSummaryTitle(params: {
  elapsedMs: number;
  toolCalls: number;
}): string {
  const seconds = Math.max(1, Math.round(params.elapsedMs / 1000));
  const tools =
    params.toolCalls > 0
      ? `, ${params.toolCalls} tool call${params.toolCalls === 1 ? "" : "s"}`
      : "";
  return `Thought for ${seconds}s${tools}`;
}
