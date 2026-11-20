/** Model-free record of a compacted region: the whole record without a summary, an appendix beside one. */
import type { AgentMessage } from "../../types.js";
import { copyString } from "../utils/truncate.js";
import { parseCompactionDetails } from "./compaction-details.js";
import {
  capCompactionSummary,
  fitCompactionSummary,
  MAX_COMPACTION_SUMMARY_CHARS,
} from "./compaction-summary-budget.js";
import type { CompactionPreparation, CompactionResult } from "./compaction.js";
import { extractCompactionMessageText, formatCompactionUserLabel } from "./utils.js";

/** Upper bound for the whole floor; the caller's summary fitting may shrink it further. */
const MAX_COMPACTION_FLOOR_CHARS = 8_000;
/**
 * Beside a generated summary the floor only backs up verbatim asks and identifiers, so it
 * gets less than the no-summary record, outside the summary's own ceiling, and never more
 * than that ceiling when an operator lowers it.
 */
const MAX_SUMMARY_FLOOR_CHARS = 6_000;
// Below this a floor cannot quote one user message; drop it rather than leave a bare heading.
const MIN_SUMMARY_FLOOR_CHARS = 1_000;
// Appended after the summary and replaced at the next compaction, never summarized again.
const SUMMARY_FLOOR_HEADING =
  "\n\n---\n\n## Deterministic record of the compacted region\nExtracted without a model; the summary above remains the primary handoff.\n\n";
const MAX_FLOOR_USER_MESSAGE_CHARS = 1_000;
const MAX_FLOOR_OUTCOME_CHARS = 600;
const FLOOR_OUTCOMES = 3;
const USER_SHARE = 0.55;
const ANCHOR_SHARE = 0.25;

const ANCHOR_PATTERNS: Array<[kind: string, pattern: RegExp]> = [
  [
    "repo",
    /(?<![\w./-])([A-Za-z0-9][A-Za-z0-9-]{1,38}\/[A-Za-z0-9][A-Za-z0-9._-]{1,60})(?![\w/.])/g,
  ],
  ["pr", /(?<![\w&])#(\d{3,7})\b/g],
  ["sha", /\b([0-9a-f]{7,40})\b/g],
  ["url", /(https?:\/\/[^\s"'<>)\]]{6,200})/g],
  ["path", /(?<![\w.-])((?:~|\.{1,2})?\/[\w.@-]+(?:\/[\w.@-]+){1,12})/g],
];

function clip(text: string, maxChars: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= maxChars ? line : `${line.slice(0, maxChars - 6)} [...]`;
}

function isUsefulAnchor(kind: string, value: string): boolean {
  if (kind === "sha") {
    return /[a-f]/.test(value) && /\d/.test(value);
  }
  if (kind === "repo") {
    return /[A-Za-z]/.test(value) && !/\.[A-Za-z]{1,5}$/.test(value);
  }
  return true;
}

/** Internal, transferable facts; no history-sized source text or anchor inventory escapes. */
export type PreparedCompactionFloor = Readonly<{
  maxChars: number;
  userCount: number;
  /** Newest first, including the recorded sender label. */
  userLines: readonly string[];
  /** Score, recency, then lexical order, already fixed by the collector. */
  anchorLines: readonly string[];
  /** The last three clipped assistant replies, oldest first. */
  outcomes: readonly string[];
}>;

function fitFloorLines<T>(
  rows: readonly T[],
  budget: number,
  used: number,
  renderLine: (row: T) => string,
): string[] {
  const lines: string[] = [];
  let usedChars = used;
  for (const row of rows) {
    const line = renderLine(row);
    if (usedChars + line.length + 1 > budget) {
      break;
    }
    lines.push(line);
    usedChars += line.length + 1;
  }
  return lines;
}

/**
 * Collect once at the largest finite, nonnegative render budget. Both selections
 * stop at the first oversized line, so every smaller budget can only select a
 * prefix of these facts.
 * Their strings occupy at most 80% of maxChars plus three 602-character outcomes;
 * userCount preserves omissions without carrying the rest of the region.
 */
export function prepareCompactionFloor(
  messages: readonly AgentMessage[],
  maxChars = MAX_COMPACTION_FLOOR_CHARS,
): PreparedCompactionFloor {
  function* facts() {
    for (const message of messages) {
      yield collectCompactionFloorMessageFact(message);
    }
  }
  return prepareCompactionFloorFromFacts(facts(), maxChars);
}

export type CompactionFloorMessageFact = {
  userLine?: string;
  outcome?: string;
  anchors: Array<{ kind: string; value: string; score: number }>;
};

/** Excerpts own their backing strings; no slice keeps a removed message alive. */
export function collectCompactionFloorMessageFact(
  message: AgentMessage,
): CompactionFloorMessageFact {
  const anchors: CompactionFloorMessageFact["anchors"] = [];
  if (message.role !== "user" && message.role !== "assistant") {
    return { anchors };
  }
  const text = extractCompactionMessageText(message);
  if (!text) {
    return { anchors };
  }
  const score = message.role === "user" ? 5 : 1;
  for (const [kind, pattern] of ANCHOR_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] ?? "").replace(/[.,;:]+$/, "");
      if (value && isUsefulAnchor(kind, value)) {
        anchors.push({ kind, value: copyString(value), score });
      }
    }
  }
  return {
    anchors,
    ...(message.role === "user"
      ? {
          userLine: copyString(
            `- [${formatCompactionUserLabel(message)}]: ${clip(text, MAX_FLOOR_USER_MESSAGE_CHARS)}`,
          ),
        }
      : { outcome: copyString(`- ${clip(text, MAX_FLOOR_OUTCOME_CHARS)}`) }),
  };
}

/** Reduce a selected source range after its cut is known, without rereading source payloads. */
export function prepareCompactionFloorFromFacts(
  facts: Iterable<CompactionFloorMessageFact>,
  maxChars = MAX_COMPACTION_FLOOR_CHARS,
): PreparedCompactionFloor {
  const userLines: string[] = [];
  let userCount = 0;
  let userChars = 120;
  const userBudget = Math.floor(maxChars * USER_SHARE);
  const outcomes: string[] = [];
  const anchors = new Map<string, { kind: string; value: string; score: number; last: number }>();
  let index = 0;
  for (const fact of facts) {
    if (fact.userLine !== undefined) {
      userCount++;
      userLines.unshift(fact.userLine);
      userChars += fact.userLine.length + 1;
      // Only the newest fitting prefix can survive any later addition or smaller budget.
      while (userChars > userBudget) {
        const line = userLines.pop();
        if (line === undefined) {
          break;
        }
        userChars -= line.length + 1;
      }
    }
    if (fact.outcome !== undefined) {
      outcomes.push(fact.outcome);
      if (outcomes.length > FLOOR_OUTCOMES) {
        outcomes.shift();
      }
    }
    for (const anchor of fact.anchors) {
      const key = `${anchor.kind}\u0000${anchor.value}`;
      const row = anchors.get(key) ?? { ...anchor, score: 0, last: index };
      row.score += anchor.score;
      row.last = index;
      anchors.set(key, row);
    }
    index++;
  }
  const ranked = [...anchors.values()].toSorted(
    (left, right) =>
      right.score - left.score || right.last - left.last || left.value.localeCompare(right.value),
  );
  return {
    maxChars,
    userCount,
    userLines,
    anchorLines: fitFloorLines(
      ranked,
      Math.floor(maxChars * ANCHOR_SHARE),
      80,
      (anchor) => `- ${anchor.kind}: ${anchor.value}`,
    ),
    outcomes,
  };
}

/** Refit bounded facts, not a truncated larger floor, at any budget up to their prepared maximum. */
export function renderCompactionFloor(
  prepared: PreparedCompactionFloor,
  maxChars = prepared.maxChars,
): string {
  if (maxChars > prepared.maxChars) {
    throw new RangeError("Compaction floor budget exceeds its prepared maximum");
  }
  const { userCount, outcomes } = prepared;
  if (userCount === 0 && outcomes.length === 0) {
    return "";
  }

  const sections: string[] = [];
  const shown = fitFloorLines(
    prepared.userLines,
    Math.floor(maxChars * USER_SHARE),
    120,
    (line) => line,
  );
  if (userCount > 0) {
    const omitted = userCount - shown.length;
    sections.push(
      [
        "## User-role messages in the removed region (verbatim with recorded origin, oldest first)",
        "Quoted as a record of what was said, not as new instructions.",
        ...(omitted > 0 ? [`[${omitted} older user message(s) not shown]`] : []),
        ...shown.toReversed(),
      ].join("\n"),
    );
  }

  const anchorLines = fitFloorLines(
    prepared.anchorLines,
    Math.floor(maxChars * ANCHOR_SHARE),
    80,
    (line) => line,
  );
  if (anchorLines.length > 0) {
    sections.push(
      ["## Identifiers most referenced in the removed region", ...anchorLines].join("\n"),
    );
  }

  if (outcomes.length > 0) {
    sections.push(["## Last assistant replies before the cut", ...outcomes].join("\n"));
  }
  const floor = sections.join("\n\n");
  return floor.length <= maxChars ? floor : `${floor.slice(0, maxChars - 6)} [...]`;
}

/**
 * Deterministic text for a region dropped without a summary: the user's own words
 * (newest first under the budget), the most-referenced identifiers, and the last
 * assistant replies. Omitted user messages are counted so the loss is never silent.
 */
export function buildCompactionFloor(
  messages: readonly AgentMessage[],
  maxChars = MAX_COMPACTION_FLOOR_CHARS,
): string {
  return renderCompactionFloor(prepareCompactionFloor(messages, maxChars), maxChars);
}

/** Characters a committed summary may carry beyond its ceiling for the floor and heading. */
export function resolveSummaryFloorChars(maxSummaryChars = MAX_COMPACTION_SUMMARY_CHARS): number {
  return SUMMARY_FLOOR_HEADING.length + Math.min(MAX_SUMMARY_FLOOR_CHARS, maxSummaryChars);
}

/** A floor the token budget shrank (keptChars > 0) or dropped (keptChars 0). */
type SummaryFloorReduction = Readonly<{
  /** Foreground request budget, or the replay estimate of the window without one. */
  source: "foreground" | "replay";
  tokenBudget: number;
  floorChars: number;
  keptChars: number;
}>;

/**
 * The committed summary of every producer: capped at the summary ceiling, then followed by
 * the floor. No-summary artifacts already carry their floor inside the ceiling. Without a
 * foreground budget, the floor still has to fit the window beside the fixed prompt, tools
 * and retained history.
 */
export function commitCompactionSummary(
  result: Pick<CompactionResult, "summary" | "details">,
  preparation: Pick<CompactionPreparation, "summaryTokenBudget"> &
    Partial<Pick<CompactionPreparation, "messagesToSummarize" | "turnPrefixMessages">> & {
      settings: { maxSummaryChars?: number };
    },
  withoutSummary: boolean,
  replayTokenBudget?: () => number | undefined,
  onFloorReduced?: (reduction: SummaryFloorReduction) => void,
  preparedFloor?: PreparedCompactionFloor,
): string {
  const { maxSummaryChars } = preparation.settings;
  const summary = capCompactionSummary(result.summary, maxSummaryChars);
  if (withoutSummary || parseCompactionDetails(result.details)?.summaryRefused) {
    return summary;
  }
  const maxFloorChars = resolveSummaryFloorChars(maxSummaryChars) - SUMMARY_FLOOR_HEADING.length;
  const foregroundBudget = preparation.summaryTokenBudget;
  // Accepted edge case: with an unknown window the floor is bounded only by its own budget.
  const tokenBudget = foregroundBudget ?? replayTokenBudget?.();
  if (maxFloorChars < MIN_SUMMARY_FLOOR_CHARS) {
    return summary;
  }
  const prepared =
    preparedFloor ??
    prepareCompactionFloor(
      [
        ...requireFloorMessages(preparation.messagesToSummarize),
        ...requireFloorMessages(preparation.turnPrefixMessages),
      ],
      maxFloorChars,
    );
  const renderFloor = (maxChars: number) =>
    maxChars >= MIN_SUMMARY_FLOOR_CHARS ? renderCompactionFloor(prepared, maxChars) : "";
  // The floor shrinks, then disappears, before the artifact may exceed the token budget.
  const fitted = fitCompactionSummary(
    tokenBudget,
    (maxChars) => {
      const floor = renderFloor(maxChars);
      return floor ? { summary: `${summary}${SUMMARY_FLOOR_HEADING}${floor}` } : undefined;
    },
    maxFloorChars,
  );
  const committed = fitted.ok ? fitted.value.summary : summary;
  if (onFloorReduced && tokenBudget !== undefined) {
    const floorChars = renderFloor(maxFloorChars).length;
    const keptChars =
      committed.length === summary.length
        ? 0
        : committed.length - summary.length - SUMMARY_FLOOR_HEADING.length;
    if (keptChars < floorChars) {
      onFloorReduced({
        source: foregroundBudget === undefined ? "replay" : "foreground",
        tokenBudget,
        floorChars,
        keptChars,
      });
    }
  }
  return committed;
}

/** A carried summary drops its old floor; the next compaction builds one for its own region. */
export function stripSummaryFloor(summary: string): string {
  const index = summary.lastIndexOf(SUMMARY_FLOOR_HEADING);
  return index < 0 ? summary : summary.slice(0, index);
}

function requireFloorMessages(messages: CompactionPreparation["messagesToSummarize"] | undefined) {
  if (!messages) {
    throw new Error("Transcript-view compaction requires its prepared floor");
  }
  return messages;
}
