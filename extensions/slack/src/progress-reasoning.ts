import type { ChannelProgressDraftLine } from "openclaw/plugin-sdk/channel-outbound";
import { countSlackTextUtf8Bytes } from "./truncate.js";

/**
 * Streamed reasoning rendered as native task cards: fixed-size segments, one
 * task row each, so the whole thought stays readable in the plan block
 * instead of one compacted narration line.
 */

/**
 * Reasoning text per card in UTF-8 bytes, the unit Slack's message size check
 * counts. With the 5-byte lane prefix a card stays within 250 bytes, under
 * the 256-character limit Slack documents per `task_update` title
 * (https://docs.slack.dev/reference/methods/chat.appendStream/) and under the
 * title cap in `progress-blocks.ts`, so no segment is ever truncated.
 */
const SLACK_REASONING_CARD_CHARS = 240;
const SLACK_REASONING_CARD_LINE_ID_PREFIX = "reasoning:";
const SLACK_REASONING_CARD_TEXT_PREFIX = "🧠 ";
/** Plan title of a message whose think continues on the next message. */
export const SLACK_REASONING_ROLLED_TITLE = "Thinking, continued below";
/** Running plan title of a continuation message. */
export const SLACK_REASONING_CONTINUED_TITLE = "Thinking, continued";

export type SlackReasoningCardLine = ChannelProgressDraftLine & { id: string };

export type SlackReasoningCardState = {
  /** Segments closed by a tool call or the end of a reasoning phase. */
  sealed: string[];
  /** Reasoning text of the phase still streaming. */
  open: string;
  /**
   * Leading part of `open` already sealed by a message rollover. The merge
   * keeps accumulating the whole phase (cumulative snapshots would otherwise
   * restart it), so only text after this prefix forms new cards.
   */
  openSealedPrefix: string;
  toolCalls: number;
};

export function createSlackReasoningCardState(): SlackReasoningCardState {
  return { sealed: [], open: "", openSealedPrefix: "", toolCalls: 0 };
}

export function isSlackReasoningCardLine(line: Pick<ChannelProgressDraftLine, "id">): boolean {
  return line.id?.startsWith(SLACK_REASONING_CARD_LINE_ID_PREFIX) === true;
}

function normalizeReasoningText(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/**
 * Splits reasoning into segments of at most `maxChars` UTF-8 bytes, never
 * splitting a code point, cutting at the last space in the second half of
 * each window. Cuts depend only on the text before them, so segments already
 * shown never change as the text grows.
 */
function segmentReasoningText(text: string, maxChars = SLACK_REASONING_CARD_CHARS): string[] {
  const chars = Array.from(normalizeReasoningText(text));
  return segmentReasoningChars(chars, maxChars).map((segment) =>
    chars.slice(segment.start, segment.end).join("").trim(),
  );
}

/** Windows (code-point indexes) of each segment of an already normalized text, sized in UTF-8 bytes. */
function segmentReasoningChars(
  chars: readonly string[],
  maxChars: number,
): Array<{ start: number; end: number }> {
  if (chars.length === 0) {
    return [];
  }
  const offsets = [0];
  for (const char of chars) {
    offsets.push((offsets.at(-1) ?? 0) + countSlackTextUtf8Bytes(char));
  }
  const units = (from: number, to: number) => (offsets[to] ?? 0) - (offsets[from] ?? 0);
  const segments: Array<{ start: number; end: number }> = [];
  let start = 0;
  while (units(start, chars.length) > maxChars) {
    let end = start;
    while (end < chars.length && units(start, end + 1) <= maxChars) {
      end += 1;
    }
    let cut = end;
    for (let index = end; units(start, index) > Math.floor(maxChars / 2); index -= 1) {
      if (chars[index] === " ") {
        cut = index;
        break;
      }
    }
    segments.push({ start, end: cut });
    start = cut;
    // Windows start on a word so a boundary cut cannot shift the next segment by one.
    while (chars[start] === " ") {
      start += 1;
    }
  }
  if (start < chars.length) {
    segments.push({ start, end: chars.length });
  }
  return segments;
}

// Code points of the normalized open text and where the unsealed part begins.
function resolveOpenReasoningWindow(state: SlackReasoningCardState): {
  chars: string[];
  start: number;
} {
  const chars = Array.from(normalizeReasoningText(state.open));
  const prefix = Array.from(state.openSealedPrefix);
  let start = 0;
  while (start < prefix.length && start < chars.length && chars[start] === prefix[start]) {
    start += 1;
  }
  while (chars[start] === " ") {
    start += 1;
  }
  return { chars, start };
}

/** Open text not yet sealed by a rollover. */
function resolveOpenReasoningText(state: SlackReasoningCardState): string {
  const { chars, start } = resolveOpenReasoningWindow(state);
  return chars.slice(start).join("").trim();
}

/** Closes the open phase: a tool call or the end of reasoning starts new cards afterwards. */
export function sealSlackReasoningCards(state: SlackReasoningCardState): void {
  state.sealed.push(...segmentReasoningText(resolveOpenReasoningText(state)));
  state.open = "";
  state.openSealedPrefix = "";
}

/**
 * Closes the cards through `throughCard` (1-based, across the turn) without
 * closing the phase: the message they are on is finished. Cards after it and
 * text streamed later stay open and continue on the next message, while the
 * compositor keeps merging the same phase. Segments are cut where they were,
 * because a cut depends only on the text before it.
 */
export function rolloverSlackReasoningCards(
  state: SlackReasoningCardState,
  throughCard: number,
): void {
  const openCards = throughCard - state.sealed.length;
  if (openCards <= 0) {
    return;
  }
  const { chars, start } = resolveOpenReasoningWindow(state);
  const remainder = chars.slice(start);
  const windows = segmentReasoningChars(remainder, SLACK_REASONING_CARD_CHARS);
  state.sealed.push(
    ...windows
      .slice(0, openCards)
      .map((window) => remainder.slice(window.start, window.end).join("").trim()),
  );
  const nextOpen = windows[openCards];
  state.openSealedPrefix = chars
    .slice(0, nextOpen ? start + nextOpen.start : chars.length)
    .join("");
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
 * complete. Ids number the segments across the whole turn; the stream
 * pipeline decides which message each card lands on.
 */
export function planSlackReasoningCards(state: SlackReasoningCardState): SlackReasoningCardLine[] {
  const openSegments = segmentReasoningText(resolveOpenReasoningText(state));
  const segments = [...state.sealed, ...openSegments];
  const openIndex = openSegments.length > 0 ? segments.length - 1 : -1;
  return segments.map((segment, index) =>
    reasoningCardLine(
      `${SLACK_REASONING_CARD_LINE_ID_PREFIX}${index + 1}`,
      segment,
      index !== openIndex,
    ),
  );
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
