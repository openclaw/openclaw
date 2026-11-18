import { estimateStringChars } from "@openclaw/normalization-core/cjk-chars";
import { sliceUtf16Safe, truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { copyString } from "../utils/truncate.js";

export const ENTRY_SEPARATOR = "\n\n";
export type ConversationTextVariant = "full" | "labeled" | "short";
export type ConversationEntryText = Record<ConversationTextVariant, string>;

/** Payload-free facts for one serialized part; a source can yield multiple parts. */
export interface ConversationEntryDescriptor<TSource = number> {
  /** Caller-owned locator, not a message or a closure over its payload. */
  source: TSource;
  partIndex: number;
  fullChars: number;
  labeledChars: number;
  shortChars: number;
  fullLength: number;
  labeledLength: number;
  shortLength: number;
  user: boolean;
  /** State immediately before this source message in the collected sequence. */
  omissionMessages: number;
  callLabel?: string;
  toolResult?: true;
}

/**
 * Upper bound for the conversation text of one summary request, in CJK-weighted
 * characters (about 40k tokens). Summary latency and cost follow this bound, not
 * the session size, so a 1M-token window compacts as fast as a 128k one.
 */
export const MAX_SUMMARY_INPUT_CHARS = 160_000;
const MAX_SAMPLED_ENTRY_CHARS = 6_000;
const MIN_TRIMMED_ENTRY_CHARS = 200;
const TRIMMED_ENTRY_HEAD_SHARE = 0.7;
// Covers truncation and elision markers for any UTF-16 length.
export const ELISION_MARKER_RESERVE_CHARS = 64;
const SUMMARY_INPUT_TAIL_SHARE = 0.5;
const SUMMARY_INPUT_USER_SHARE = 0.25;
const SUMMARY_INPUT_HEAD_SHARE = 0.1;
const SUMMARY_INPUT_MIDDLE_SLICES = 8;
// Older user messages share their budget evenly, within these bounds each.
const MAX_USER_ENTRY_CHARS = 2_000;
const MIN_USER_ENTRY_CHARS = 400;
// A gap marker ("[... 12345 entries omitted ...]") and its separator stay under 40 characters.
const OMISSION_MARKER_CHARS = 40;

/**
 * Keep both ends of `text` within `maxChars` CJK-weighted characters: the start
 * usually states the request and the end its latest instruction or result.
 * Weighted length is at least the UTF-16 length, so each binary search is
 * bounded by the weight budget, not by the size of the text.
 */
function elideMiddleWithinWeight(text: string, maxChars: number): string | undefined {
  const available = maxChars - ELISION_MARKER_RESERVE_CHARS;
  if (available < MIN_TRIMMED_ENTRY_CHARS) {
    return undefined;
  }
  const headBudget = Math.floor(available * TRIMMED_ENTRY_HEAD_SHARE);
  let low = 0;
  let high = Math.min(text.length, headBudget);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (estimateStringChars(truncateUtf16Safe(text, mid)) <= headBudget) {
      low = mid;
    } else {
      high = mid - 1;
    }
  }
  const head = truncateUtf16Safe(text, low);
  const tailBudget = available - estimateStringChars(head);
  low = Math.max(head.length, text.length - tailBudget);
  high = text.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (estimateStringChars(sliceUtf16Safe(text, mid)) <= tailBudget) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }
  const tail = sliceUtf16Safe(text, low);
  return `${head}\n\n[... ${text.length - head.length - tail.length} characters omitted ...]\n\n${tail}`;
}

export interface BoundedConversation {
  text: string;
  /** Entries left out entirely; the text names each gap where it occurs. */
  omittedEntries: number;
  /** Entries kept with their middle elided. */
  trimmedEntries: number;
}

/**
 * Render descriptors for one summary request within `maxChars` CJK-weighted
 * characters. Small inputs are unchanged. Larger inputs keep, in this order:
 * the newest entries verbatim (half the budget); older user messages, which
 * carry the asks, decisions and corrections (a quarter, newest first, each up
 * to 2,000 characters); the oldest entries (a tenth); and eight evenly spaced
 * runs of what remains. Older tool results keep 500 characters of their head
 * and tail instead of 2,000. Sampled entries are trimmed to 6,000 characters, every
 * gap is marked with its entry count, and each tool result names its call,
 * because sampling can separate the two. The transcript itself is not changed.
 * Only candidate text is read synchronously, inside the source reader's lifetime;
 * descriptors and the bounded selection never retain unselected source payloads.
 */
export function renderConversationEntriesWithinBudget<
  TEntry extends ConversationEntryDescriptor<unknown>,
>(
  entries: readonly TEntry[],
  maxChars: number,
  readText: (entry: TEntry, variant: ConversationTextVariant) => string,
): BoundedConversation {
  const separatorChars = ENTRY_SEPARATOR.length;
  const totalChars =
    entries.reduce((sum, entry) => sum + entry.fullChars, 0) +
    separatorChars * Math.max(0, entries.length - 1);
  if (totalChars <= maxChars) {
    return {
      text: entries.map((entry) => copyString(readText(entry, "full"))).join(ENTRY_SEPARATOR),
      omittedEntries: 0,
      trimmedEntries: 0,
    };
  }
  let shortenOlder = false;
  let tailStart = entries.length;
  const weight = (index: number) =>
    (shortenOlder && index < tailStart
      ? entries[index]?.shortChars
      : entries[index]?.labeledChars) ?? 0;

  const selected = new Map<number, string>();
  let trimmedEntries = 0;
  // Every maximal run of left-out entries renders one marker; the whole span starts as one.
  let usedChars = OMISSION_MARKER_CHARS;

  // Keeps the entry within `limit`, eliding its middle when needed. The cost
  // includes the change in gap markers: taking an entry inside a gap splits it.
  const take = (index: number, limit: number, maxEntryChars = limit): boolean => {
    if (selected.has(index)) {
      return true;
    }
    const descriptor = entries[index];
    if (!descriptor) {
      return false;
    }
    const leftOpen = index > 0 && !selected.has(index - 1);
    const rightOpen = index < entries.length - 1 && !selected.has(index + 1);
    const markerDelta = leftOpen && rightOpen ? 1 : !leftOpen && !rightOpen ? -1 : 0;
    const markerCost = markerDelta * OMISSION_MARKER_CHARS;
    const entryLimit = Math.min(limit - markerCost, maxEntryChars + separatorChars);
    let chars = weight(index) + separatorChars;
    // Reject impossible candidates from metadata, without reading their source rows.
    if (
      chars > entryLimit &&
      entryLimit - separatorChars - ELISION_MARKER_RESERVE_CHARS < MIN_TRIMMED_ENTRY_CHARS
    ) {
      return false;
    }
    if (chars <= entryLimit && usedChars + chars + markerCost > maxChars) {
      return false;
    }
    const entry = readText(descriptor, shortenOlder && index < tailStart ? "short" : "labeled");
    let text = entry;
    if (chars > entryLimit) {
      const trimmed = elideMiddleWithinWeight(entry, entryLimit - separatorChars);
      if (trimmed === undefined) {
        return false;
      }
      text = trimmed;
      chars = estimateStringChars(trimmed) + separatorChars;
    }
    // Shares only order the passes; the whole input never exceeds maxChars.
    if (usedChars + chars + markerCost > maxChars) {
      return false;
    }
    if (text !== entry) {
      trimmedEntries += 1;
    }
    selected.set(index, copyString(text));
    usedChars += chars + markerCost;
    return true;
  };

  // Newest entries carry the live task, so they stay verbatim. Only the newest
  // entry may be trimmed, when it alone exceeds the tail share.
  const tailLimit = Math.floor(maxChars * SUMMARY_INPUT_TAIL_SHARE);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const remaining = tailLimit - usedChars;
    const verbatim = weight(index) + separatorChars <= remaining;
    if ((!verbatim && tailStart !== entries.length) || !take(index, remaining)) {
      break;
    }
    tailStart = index;
  }
  // Shorter older results leave room for the user and assistant text the summary is built from.
  shortenOlder = true;

  // Older user messages state what was asked, decided and corrected; a fact the
  // user gave once must not depend on where the samples fall. When they do not
  // all fit, they are spread evenly across the history, newest first.
  const olderUsers: number[] = [];
  for (let index = 0; index < tailStart; index++) {
    if (entries[index]?.user) {
      olderUsers.push(index);
    }
  }
  if (olderUsers.length > 0) {
    const userBudget = Math.floor(maxChars * SUMMARY_INPUT_USER_SHARE);
    const userLimit = usedChars + userBudget;
    const userEntryChars = Math.min(
      MAX_USER_ENTRY_CHARS,
      Math.max(
        MIN_USER_ENTRY_CHARS,
        Math.floor(userBudget / olderUsers.length - OMISSION_MARKER_CHARS),
      ),
    );
    const userCosts = olderUsers.reduce(
      (sum, index) =>
        sum +
        Math.min(weight(index) + separatorChars, userEntryChars + separatorChars) +
        OMISSION_MARKER_CHARS,
      0,
    );
    const stride = Math.max(1, userCosts / userBudget);
    for (let position = olderUsers.length - 1; position >= 0; position -= stride) {
      const index = olderUsers[Math.round(position)];
      if (index === undefined || !take(index, userLimit - usedChars, userEntryChars)) {
        break;
      }
    }
  }

  // The oldest entries usually state the goal and the constraints of the session.
  let headEnd = 0;
  const headLimit = usedChars + Math.floor(maxChars * SUMMARY_INPUT_HEAD_SHARE);
  while (headEnd < tailStart && take(headEnd, headLimit - usedChars, MAX_SAMPLED_ENTRY_CHARS)) {
    headEnd += 1;
  }

  // Evenly spaced runs show how the remaining span developed.
  const middleCount = tailStart - headEnd;
  if (middleCount > 0) {
    const sliceLimit = Math.floor((maxChars - usedChars) / SUMMARY_INPUT_MIDDLE_SLICES);
    let nextFree = headEnd;
    for (let slice = 0; slice < SUMMARY_INPUT_MIDDLE_SLICES; slice += 1) {
      let index = Math.max(
        nextFree,
        headEnd + Math.floor((slice * middleCount) / SUMMARY_INPUT_MIDDLE_SLICES),
      );
      const sliceEnd = usedChars + sliceLimit;
      while (index < tailStart && take(index, sliceEnd - usedChars, MAX_SAMPLED_ENTRY_CHARS)) {
        index += 1;
      }
      nextFree = index;
    }
  }

  const parts: string[] = [];
  let omittedEntries = 0;
  let gap = 0;
  // The extra iteration flushes a trailing gap.
  for (let index = 0; index <= entries.length; index += 1) {
    const text = selected.get(index);
    if (text === undefined && index < entries.length) {
      gap += 1;
      continue;
    }
    if (gap > 0) {
      parts.push(`[... ${gap} ${gap === 1 ? "entry" : "entries"} omitted ...]`);
      omittedEntries += gap;
      gap = 0;
    }
    if (text !== undefined) {
      parts.push(text);
    }
  }
  return { text: parts.join(ENTRY_SEPARATOR), omittedEntries, trimmedEntries };
}
