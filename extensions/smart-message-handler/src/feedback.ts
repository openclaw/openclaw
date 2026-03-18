import type { ExecutionKind } from "./types.ts";

interface FeedbackEntry {
  readonly timestamp: number;
  readonly predictedKind: ExecutionKind;
  readonly actualToolName: string;
  readonly matched: boolean;
}

const MAX_FEEDBACK = 500;
const ringBuffer: (FeedbackEntry | null)[] = Array.from<FeedbackEntry | null>({
  length: MAX_FEEDBACK,
}).fill(null);
let writeIndex = 0;
let entryCount = 0;

// Map tool names to expected execution kinds
const TOOL_KIND_MAP: Record<string, ExecutionKind> = {
  // Search tools
  grep: "search",
  find: "search",
  search: "search",
  // Read tools
  read: "read",
  cat: "read",
  read_file: "read",
  // Write tools
  write: "write",
  edit: "write",
  write_file: "write",
  // Run tools
  bash: "run",
  execute: "run",
  // Install — often via bash
  npm: "install",
  pip: "install",
};

const lastPredictions = new Map<string, ExecutionKind>();

export function setLastPrediction(kind: ExecutionKind, sessionKey: string): void {
  lastPredictions.set(sessionKey, kind);
}

export function getLastPrediction(sessionKey: string): ExecutionKind {
  return lastPredictions.get(sessionKey) || "unknown";
}

export function recordToolUsage(toolName: string, sessionKey: string): void {
  const normalizedTool = toolName.toLowerCase();
  const expectedKind = TOOL_KIND_MAP[normalizedTool];
  if (!expectedKind) {
    return;
  } // Unknown tool, skip

  const predicted = lastPredictions.get(sessionKey) || "unknown";
  const matched = predicted === expectedKind;
  const entry: FeedbackEntry = {
    timestamp: Date.now(),
    predictedKind: predicted,
    actualToolName: normalizedTool,
    matched,
  };
  ringBuffer[writeIndex] = entry;
  writeIndex = (writeIndex + 1) % MAX_FEEDBACK;
  if (entryCount < MAX_FEEDBACK) {
    entryCount++;
  }
}

function getFeedbackEntries(): FeedbackEntry[] {
  const result: FeedbackEntry[] = [];
  if (entryCount < MAX_FEEDBACK) {
    for (let i = 0; i < entryCount; i++) {
      const e = ringBuffer[i];
      if (e) {
        result.push(e);
      }
    }
  } else {
    for (let i = 0; i < MAX_FEEDBACK; i++) {
      const e = ringBuffer[(writeIndex + i) % MAX_FEEDBACK];
      if (e) {
        result.push(e);
      }
    }
  }
  return result;
}

export function getFeedbackStats(): {
  readonly total: number;
  readonly matchRate: string;
  readonly mismatches: readonly {
    readonly predicted: string;
    readonly actualTool: string;
    readonly count: number;
  }[];
} {
  const entries = getFeedbackEntries();
  const total = entries.length;
  const matches = entries.filter((f) => f.matched).length;

  const mismatchMap = new Map<string, number>();
  for (const f of entries) {
    if (!f.matched) {
      const key = `${f.predictedKind}\u2192${f.actualToolName}`;
      mismatchMap.set(key, (mismatchMap.get(key) || 0) + 1);
    }
  }

  const mismatches = Array.from(mismatchMap.entries())
    .map(([key, count]) => {
      const [predicted, actualTool] = key.split("\u2192");
      return { predicted, actualTool, count };
    })
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    total,
    matchRate: total > 0 ? `${((matches / total) * 100).toFixed(1)}%` : "N/A",
    mismatches,
  };
}

export function formatFeedbackReport(): string {
  const stats = getFeedbackStats();
  const lines = [
    `Feedback Report`,
    `Total observations: ${stats.total}`,
    `Prediction match rate: ${stats.matchRate}`,
  ];
  if (stats.mismatches.length > 0) {
    lines.push(`\nTop mismatches:`);
    for (const m of stats.mismatches) {
      lines.push(`  predicted:${m.predicted} but used tool:${m.actualTool} (${m.count}x)`);
    }
  }
  return lines.join("\n");
}

export function resetFeedback(): void {
  ringBuffer.fill(null);
  writeIndex = 0;
  entryCount = 0;
  lastPredictions.clear();
}

export function getFeedbackLog(): readonly FeedbackEntry[] {
  return getFeedbackEntries();
}
