/** Model-free record of a compacted region: the whole record without a summary, an appendix beside one. */
import type { AgentMessage } from "../../types.js";
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

/**
 * Deterministic text for a region dropped without a summary: the user's own words
 * (newest first under the budget), the most-referenced identifiers, and the last
 * assistant replies. Omitted user messages are counted so the loss is never silent.
 */
type FloorAnchor = { kind: string; value: string; score: number; last: number };
export type CompactionFloorMessage = {
  user?: { label: string; text: string };
  assistant?: string;
  anchors: Omit<FloorAnchor, "last">[];
};
export type PreparedCompactionFloor = {
  users: Array<{ label: string; text: string }>;
  userCount: number;
  assistants: string[];
  anchors: FloorAnchor[];
};

/** Record only bounded excerpts and identifier counts while a payload is resident. */
export function prepareCompactionFloorMessage(message: AgentMessage): CompactionFloorMessage {
  if (message.role !== "user" && message.role !== "assistant") {
    return { anchors: [] };
  }
  const text = extractCompactionMessageText(message);
  if (!text) {
    return { anchors: [] };
  }
  const anchors = new Map<string, Omit<FloorAnchor, "last">>();
  for (const [kind, pattern] of ANCHOR_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const value = (match[1] ?? "").replace(/[.,;:]+$/, "");
      if (!value || !isUsefulAnchor(kind, value)) {
        continue;
      }
      const key = kind + "\u0000" + value;
      const row = anchors.get(key) ?? { kind, value, score: 0 };
      row.score += message.role === "user" ? 5 : 1;
      anchors.set(key, row);
    }
  }
  // Excerpts and regex captures can retain the entire payload as sliced strings.
  // Detach these bounded facts before the worker caches them across transcript reads.
  return structuredClone({
    ...(message.role === "user"
      ? {
          user: {
            label: formatCompactionUserLabel(message),
            text: clip(text, MAX_FLOOR_USER_MESSAGE_CHARS),
          },
        }
      : { assistant: clip(text, MAX_FLOOR_OUTCOME_CHARS) }),
    anchors: [...anchors.values()],
  });
}

/** Keep only the suffix and ranked identifiers any supported floor budget can emit. */
export function prepareCompactionFloor(
  messages: Iterable<CompactionFloorMessage>,
  maxChars = MAX_COMPACTION_FLOOR_CHARS,
): PreparedCompactionFloor {
  const users: PreparedCompactionFloor["users"] = [];
  const assistants: string[] = [];
  const anchors = new Map<string, FloorAnchor>();
  let userCount = 0;
  let userChars = 120;
  let index = 0;
  for (const message of messages) {
    if (message.user) {
      userCount++;
      users.push(message.user);
      userChars += message.user.label.length + message.user.text.length + 7;
      while (users.length && userChars > Math.floor(maxChars * USER_SHARE)) {
        const removed = users.shift();
        if (removed) {
          userChars -= removed.label.length + removed.text.length + 7;
        }
      }
    }
    if (message.assistant) {
      assistants.push(message.assistant);
      if (assistants.length > FLOOR_OUTCOMES) {
        assistants.shift();
      }
    }
    for (const anchor of message.anchors) {
      const key = anchor.kind + "\u0000" + anchor.value;
      const previous = anchors.get(key);
      anchors.set(key, { ...anchor, score: (previous?.score ?? 0) + anchor.score, last: index });
    }
    index++;
  }
  const ranked = [...anchors.values()].toSorted(
    (left, right) =>
      right.score - left.score || right.last - left.last || left.value.localeCompare(right.value),
  );
  let anchorChars = 80;
  const selected: FloorAnchor[] = [];
  for (const anchor of ranked) {
    anchorChars += anchor.kind.length + anchor.value.length + 5;
    if (anchorChars > Math.floor(maxChars * ANCHOR_SHARE)) {
      break;
    }
    selected.push(anchor);
  }
  return { users, userCount, assistants, anchors: selected };
}

export function buildCompactionFloor(
  messages: readonly AgentMessage[],
  maxChars = MAX_COMPACTION_FLOOR_CHARS,
): string {
  return renderCompactionFloor(
    prepareCompactionFloor(messages.map(prepareCompactionFloorMessage), maxChars),
    maxChars,
  );
}

export function renderCompactionFloor(
  prepared: PreparedCompactionFloor,
  maxChars = MAX_COMPACTION_FLOOR_CHARS,
): string {
  const { users, userCount, assistants, anchors } = prepared;
  if (userCount === 0 && assistants.length === 0) {
    return "";
  }
  const sections: string[] = [];
  const userBudget = Math.floor(maxChars * USER_SHARE);
  const shown: string[] = [];
  let used = 120;
  for (const { label, text } of users.toReversed()) {
    const line = `- [${label}]: ${clip(text, MAX_FLOOR_USER_MESSAGE_CHARS)}`;
    if (used + line.length + 1 > userBudget) {
      break;
    }
    shown.push(line);
    used += line.length + 1;
  }
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

  const anchorBudget = Math.floor(maxChars * ANCHOR_SHARE);
  const ranked = anchors;
  const anchorLines: string[] = [];
  used = 80;
  for (const anchor of ranked) {
    const line = `- ${anchor.kind}: ${anchor.value}`;
    if (used + line.length + 1 > anchorBudget) {
      break;
    }
    anchorLines.push(line);
    used += line.length + 1;
  }
  if (anchorLines.length > 0) {
    sections.push(
      ["## Identifiers most referenced in the removed region", ...anchorLines].join("\n"),
    );
  }

  const outcomes = assistants
    .slice(-FLOOR_OUTCOMES)
    .map((text) => `- ${clip(text, MAX_FLOOR_OUTCOME_CHARS)}`);
  if (outcomes.length > 0) {
    sections.push(["## Last assistant replies before the cut", ...outcomes].join("\n"));
  }
  const floor = sections.join("\n\n");
  return floor.length <= maxChars ? floor : `${floor.slice(0, maxChars - 6)} [...]`;
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
  preparation: Pick<
    CompactionPreparation,
    "messagesToSummarize" | "turnPrefixMessages" | "summaryTokenBudget" | "floor"
  > & { settings: { maxSummaryChars?: number } },
  withoutSummary: boolean,
  replayTokenBudget?: () => number | undefined,
  onFloorReduced?: (reduction: SummaryFloorReduction) => void,
): string {
  const { maxSummaryChars } = preparation.settings;
  const summary = capCompactionSummary(result.summary, maxSummaryChars);
  if (withoutSummary || parseCompactionDetails(result.details)?.summaryRefused) {
    return summary;
  }
  const prepared =
    preparation.floor ??
    prepareCompactionFloor(
      [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages].map(
        prepareCompactionFloorMessage,
      ),
    );
  const renderFloor = (maxChars: number) =>
    maxChars >= MIN_SUMMARY_FLOOR_CHARS ? renderCompactionFloor(prepared, maxChars) : "";
  const maxFloorChars = resolveSummaryFloorChars(maxSummaryChars) - SUMMARY_FLOOR_HEADING.length;
  const foregroundBudget = preparation.summaryTokenBudget;
  // Accepted edge case: with an unknown window the floor is bounded only by its own budget.
  const tokenBudget = foregroundBudget ?? replayTokenBudget?.();
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
