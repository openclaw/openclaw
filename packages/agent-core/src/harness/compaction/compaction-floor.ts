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

const SECRET_PATTERNS = [
  /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|xox[abprs]|glpat|AKIA|AIza)[-_A-Za-z0-9]{16,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\b(?:api[_-]?key|token|secret|password|passwd|authorization|bearer)\b\s*[:=]\s*["']?[^\s"']{8,}/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
];

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

function redactSecrets(text: string): string {
  return SECRET_PATTERNS.reduce((value, pattern) => value.replace(pattern, "[redacted]"), text);
}

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
export function buildCompactionFloor(
  messages: readonly AgentMessage[],
  maxChars = MAX_COMPACTION_FLOOR_CHARS,
): string {
  const users: Array<{ label: string; text: string }> = [];
  const assistants: string[] = [];
  const anchors = new Map<string, { kind: string; value: string; score: number; last: number }>();
  messages.forEach((message, index) => {
    if (message.role !== "user" && message.role !== "assistant") {
      return;
    }
    // Redact once, before excerpts and anchors, so no detached credential fragment survives.
    const text = redactSecrets(extractCompactionMessageText(message));
    if (!text) {
      return;
    }
    // Keep recorded origin and sender: user-role rows also carry internal and inter-session input.
    if (message.role === "user") {
      users.push({ label: formatCompactionUserLabel(message), text });
    } else {
      assistants.push(text);
    }
    const weight = message.role === "user" ? 5 : 1;
    for (const [kind, pattern] of ANCHOR_PATTERNS) {
      for (const match of text.matchAll(pattern)) {
        const value = (match[1] ?? "").replace(/[.,;:]+$/, "");
        if (!value || !isUsefulAnchor(kind, value)) {
          continue;
        }
        const key = `${kind}\u0000${value}`;
        const row = anchors.get(key) ?? { kind, value, score: 0, last: index };
        row.score += weight;
        row.last = index;
        anchors.set(key, row);
      }
    }
  });
  if (users.length === 0 && assistants.length === 0) {
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
  if (users.length > 0) {
    const omitted = users.length - shown.length;
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
  const ranked = [...anchors.values()].toSorted(
    (left, right) =>
      right.score - left.score || right.last - left.last || left.value.localeCompare(right.value),
  );
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
    "messagesToSummarize" | "turnPrefixMessages" | "summaryTokenBudget"
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
  const messages = [...preparation.messagesToSummarize, ...preparation.turnPrefixMessages];
  const renderFloor = (maxChars: number) =>
    maxChars >= MIN_SUMMARY_FLOOR_CHARS ? buildCompactionFloor(messages, maxChars) : "";
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
