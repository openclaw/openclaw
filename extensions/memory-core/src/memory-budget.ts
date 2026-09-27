import { resolveAgentConfig } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";

const PROMOTION_SECTION_HEADING_RE = /^## Promoted From Short-Term Memory \(([^)]+)\)\s*$/;

const PROMOTION_SUBSECTION_HEADING_RE = /^### (?:Global|Project: .+?)\s*$/;

const PROMOTION_ENTRY_MARKER_RE = /^<!--\s*openclaw-memory-promotion:.*-->\s*$/i;

const ATX_HEADING_RE = /^ {0,3}#{1,6}(?:[ \t]|$)/;

const SETEXT_HEADING_UNDERLINE_RE = /^ {0,3}(?:=+|-+)[ \t]*$/;

// Stay below bootstrap's per-file injection cap so promotion remains visible (#73691).
export const DEFAULT_MEMORY_FILE_MAX_CHARS = 10_000;

/**
 * Keep promotion output within every consuming agent's per-file bootstrap
 * budget. An unconfigured bootstrap limit stays above the promotion writer's
 * own ceiling, so only explicit lower limits need to reduce the budget here.
 */
export function resolveMemoryPromotionFileMaxChars(params: {
  cfg?: OpenClawConfig;
  agentIds: readonly string[];
}): number {
  const defaultBootstrapLimit = params.cfg?.agents?.defaults?.bootstrapMaxChars;
  const agentIds: Array<string | undefined> =
    params.agentIds.length > 0 ? [...new Set(params.agentIds)] : [undefined];
  let limit = DEFAULT_MEMORY_FILE_MAX_CHARS;

  for (const agentId of agentIds) {
    const configuredLimit = agentId
      ? (resolveAgentConfig(params.cfg ?? {}, agentId)?.bootstrapMaxChars ?? defaultBootstrapLimit)
      : defaultBootstrapLimit;
    if (
      typeof configuredLimit === "number" &&
      Number.isFinite(configuredLimit) &&
      configuredLimit > 0
    ) {
      limit = Math.min(limit, Math.floor(configuredLimit));
    }
  }
  return limit;
}

// applyShortTermPromotions may restore the empty-file header (20 chars) and final newline.
const WRITE_OVERHEAD_RESERVE = 21;

type MemoryBlock =
  | { kind: "preserved"; text: string }
  | { kind: "promotion"; date: string; text: string; entryCount: number };

function isGeneratedPromotionBlock(lines: string[]): boolean {
  let sawEntry = false;
  let index = 1;

  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (PROMOTION_SUBSECTION_HEADING_RE.test(line)) {
      index += 1;
      while (index < lines.length && (lines[index] ?? "").trim().length === 0) {
        index += 1;
      }
    }

    if (!PROMOTION_ENTRY_MARKER_RE.test(lines[index] ?? "")) {
      return false;
    }
    // A marker owns only the single bullet emitted with it. Treat any other
    // body shape as mixed user content so compaction cannot delete it.
    if (!(lines[index + 1] ?? "").startsWith("- ")) {
      return false;
    }
    sawEntry = true;
    index += 2;
  }

  return sawEntry;
}

function startsGeneratedPromotionSubsection(lines: string[], index: number): boolean {
  if (!PROMOTION_SUBSECTION_HEADING_RE.test(lines[index] ?? "")) {
    return false;
  }
  for (let next = index + 1; next < lines.length; next += 1) {
    const line = lines[next] ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    return PROMOTION_ENTRY_MARKER_RE.test(line);
  }
  return false;
}

function takeSetextHeadingLines(lines: string[]): string[] | undefined {
  let start = lines.length;
  while (start > 1 && lines[start - 1]?.trim().length !== 0) {
    start -= 1;
  }
  if (start === lines.length) {
    return undefined;
  }
  const headingLines = lines.slice(start);
  if (headingLines.some((line) => PROMOTION_ENTRY_MARKER_RE.test(line))) {
    return undefined;
  }
  lines.splice(start);
  return headingLines;
}

function parseMemoryBlocks(content: string): MemoryBlock[] {
  if (content.length === 0) {
    return [];
  }
  const lines = content.split(/\r?\n/);
  const blocks: MemoryBlock[] = [];
  let currentLines: string[] = [];
  let currentDate: string | undefined;

  const flush = () => {
    if (currentLines.length === 0) {
      return;
    }
    const text = currentLines.join("\n");
    if (currentDate && isGeneratedPromotionBlock(currentLines)) {
      blocks.push({
        kind: "promotion",
        date: currentDate,
        text,
        entryCount: currentLines.filter((line) => PROMOTION_ENTRY_MARKER_RE.test(line)).length,
      });
    } else {
      blocks.push({ kind: "preserved", text });
    }
    currentLines = [];
    currentDate = undefined;
  };

  for (const [index, line] of lines.entries()) {
    if (currentDate && SETEXT_HEADING_UNDERLINE_RE.test(line)) {
      const headingLines = takeSetextHeadingLines(currentLines);
      if (headingLines) {
        flush();
        currentLines = [...headingLines, line];
        continue;
      }
    }
    const continuesPromotionBody = currentDate && startsGeneratedPromotionSubsection(lines, index);
    if (ATX_HEADING_RE.test(line) && !continuesPromotionBody) {
      flush();
      currentDate = PROMOTION_SECTION_HEADING_RE.exec(line)?.[1];
      currentLines = [line];
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return blocks;
}

export type CompactMemoryParams = {
  existingMemory: string;
  newSection: string;
  budgetChars: number;
  /** Maximum fraction of existing generated entries that this write may remove. */
  maxPriorEntryLossFraction?: number;
};

type CompactMemoryResult = {
  compacted: string;
  droppedDates: string[];
};

/** Drop oldest fully generated sections within the loss bound; the caller owns the final fit check. */
export function compactMemoryForBudget(params: CompactMemoryParams): CompactMemoryResult {
  const { existingMemory, newSection, budgetChars } = params;
  if (budgetChars <= 0) {
    return { compacted: existingMemory, droppedDates: [] };
  }

  const effectiveBudget = Math.max(0, budgetChars - WRITE_OVERHEAD_RESERVE);

  if (existingMemory.length + newSection.length <= effectiveBudget) {
    return { compacted: existingMemory, droppedDates: [] };
  }

  const blocks = parseMemoryBlocks(existingMemory);
  const promotionEntries = blocks
    .flatMap((block, index) =>
      block.kind === "promotion"
        ? [
            {
              index,
              date: block.date,
              length: block.text.length,
              entryCount: block.entryCount,
            },
          ]
        : [],
    )
    .toSorted((a, b) => a.date.localeCompare(b.date));

  if (promotionEntries.length === 0) {
    return { compacted: existingMemory, droppedDates: [] };
  }

  const droppedIndices = new Set<number>();
  const droppedDates: string[] = [];
  const totalEntryCount = promotionEntries.reduce((total, entry) => total + entry.entryCount, 0);
  const maxLossFraction = Math.max(0, Math.min(1, params.maxPriorEntryLossFraction ?? 1));
  let droppedEntryCount = 0;
  let projectedExistingSize = existingMemory.length;
  // Block boundaries cost one newline each; subtract a
  // newline along with the block text so the projection stays honest.
  const blockSeparatorCost = blocks.length > 1 ? 1 : 0;

  for (const entry of promotionEntries) {
    if (projectedExistingSize + newSection.length <= effectiveBudget) {
      break;
    }
    if (
      totalEntryCount > 0 &&
      (droppedEntryCount + entry.entryCount) / totalEntryCount > maxLossFraction
    ) {
      break;
    }
    droppedIndices.add(entry.index);
    droppedDates.push(entry.date);
    droppedEntryCount += entry.entryCount;
    projectedExistingSize = Math.max(0, projectedExistingSize - entry.length - blockSeparatorCost);
  }

  if (droppedIndices.size === 0) {
    return { compacted: existingMemory, droppedDates: [] };
  }

  const remaining = blocks.filter((_, index) => !droppedIndices.has(index));
  return { compacted: remaining.map((block) => block.text).join("\n"), droppedDates };
}
