import { isComplete } from "./classifier.ts";
import type { SmartHandlerConfig, ExecutionIntent, ExecutionKind } from "./types.ts";

// Baseline classifier -- simple first-match (the old v1.0 algorithm)
const BASELINE_KEYWORDS: Record<Exclude<ExecutionKind, "unknown">, readonly string[]> = {
  search: ["搜索", "查找", "search", "find", "grep"],
  install: ["安装", "install", "npm", "pip", "brew"],
  read: ["读取", "查看", "read", "cat"],
  run: ["运行", "执行", "跑", "run", "execute", "start"],
  write: ["创建", "修改", "write", "create", "edit"],
  debug: ["调试", "修复", "bug", "debug", "fix", "error"],
  analyze: ["分析", "解释", "analyze", "explain"],
  chat: ["聊聊", "聊天", "chat", "你好"],
};

/**
 * Baseline classifier — intentionally naive first-match keyword lookup.
 *
 * Uses the same algorithm as v1.0 (insertion-order Object.entries iteration).
 * Known biases: single-character keywords like "找"/"看"/"写" cause systematic
 * misclassification when they appear before more specific keywords in the
 * iteration order. This is expected — the baseline serves as a reference for
 * measuring the current scorer's improvement, not as a correct classifier.
 */
export function classifyBaseline(message: string, config: SmartHandlerConfig): ExecutionIntent {
  const trimmed = message.trim().toLowerCase();
  const input_finalized = isComplete(message, config);
  const execution_expected = input_finalized && trimmed.length >= config.minMessageLength;

  let execution_kind: ExecutionKind = "unknown";
  for (const [kind, keywords] of Object.entries(BASELINE_KEYWORDS)) {
    if (kind === "unknown") {
      continue;
    }
    for (const kw of keywords) {
      if (trimmed.includes(kw.toLowerCase())) {
        execution_kind = kind as ExecutionKind;
        break;
      }
    }
    if (execution_kind !== "unknown") {
      break;
    }
  }

  if (execution_kind === "unknown" && execution_expected) {
    execution_kind = "run";
  }

  return {
    input_finalized,
    execution_expected,
    execution_kind,
  };
}

export interface ShadowDivergence {
  readonly timestamp: number;
  /** First 50 chars in production, up to 100 chars in debug mode. For debugging only — not included in reports. */
  readonly messagePreview: string;
  readonly currentResult: ExecutionKind;
  readonly baselineResult: ExecutionKind;
  readonly currentScore: number;
  readonly agreed: boolean;
}

const MAX_LOG_SIZE = 1000;
const ringBuffer: (ShadowDivergence | null)[] = Array.from<ShadowDivergence | null>({
  length: MAX_LOG_SIZE,
}).fill(null);
let writeIndex = 0;
let entryCount = 0;

export function recordDivergence(divergence: ShadowDivergence): void {
  ringBuffer[writeIndex] = divergence;
  writeIndex = (writeIndex + 1) % MAX_LOG_SIZE;
  if (entryCount < MAX_LOG_SIZE) {
    entryCount++;
  }
}

export function getDivergenceLog(): readonly ShadowDivergence[] {
  const result: ShadowDivergence[] = [];
  if (entryCount < MAX_LOG_SIZE) {
    // Buffer not full yet — entries are 0..writeIndex-1
    for (let i = 0; i < entryCount; i++) {
      const entry = ringBuffer[i];
      if (entry) {
        result.push(entry);
      }
    }
  } else {
    // Buffer full — oldest is at writeIndex, wrap around
    for (let i = 0; i < MAX_LOG_SIZE; i++) {
      const idx = (writeIndex + i) % MAX_LOG_SIZE;
      const entry = ringBuffer[idx];
      if (entry) {
        result.push(entry);
      }
    }
  }
  return result;
}

export function getDivergenceStats(): {
  total: number;
  agreements: number;
  divergences: number;
  agreementRate: string;
  topDivergences: Array<{ from: ExecutionKind; to: ExecutionKind; count: number }>;
} {
  const log = getDivergenceLog();
  const total = log.length;
  const agreements = log.filter((d) => d.agreed).length;
  const divergences = total - agreements;

  // Count divergence patterns
  const patterns = new Map<string, number>();
  for (const d of log) {
    if (!d.agreed) {
      const key = `${d.baselineResult}\u2192${d.currentResult}`;
      patterns.set(key, (patterns.get(key) || 0) + 1);
    }
  }

  const topDivergences = Array.from(patterns.entries())
    .map(([key, count]) => {
      const [from, to] = key.split("\u2192") as [ExecutionKind, ExecutionKind];
      return { from, to, count };
    })
    .toSorted((a, b) => b.count - a.count)
    .slice(0, 10);

  return {
    total,
    agreements,
    divergences,
    agreementRate: total > 0 ? `${((agreements / total) * 100).toFixed(1)}%` : "N/A",
    topDivergences,
  };
}

export function resetDivergenceLog(): void {
  ringBuffer.fill(null);
  writeIndex = 0;
  entryCount = 0;
}

export function formatDivergenceReport(): string {
  const stats = getDivergenceStats();
  const lines = [
    `Shadow Mode Report`,
    `Total comparisons: ${stats.total}`,
    `Agreements: ${stats.agreements} (${stats.agreementRate})`,
    `Divergences: ${stats.divergences}`,
  ];
  if (stats.topDivergences.length > 0) {
    lines.push(`\nTop divergence patterns:`);
    for (const d of stats.topDivergences) {
      lines.push(`  baseline:${d.from} \u2192 current:${d.to} (${d.count}x)`);
    }
  }
  return lines.join("\n");
}
