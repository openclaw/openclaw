import type { FailurePattern } from "../alpha-factory/types.js";

export class FailureFeedbackStore {
  private patterns: FailurePattern[] = [];

  record(pattern: FailurePattern): void {
    this.patterns.push(pattern);
  }

  getRecentPatterns(limit = 50): FailurePattern[] {
    return this.patterns.slice(-limit);
  }

  /** Format failure patterns as markdown for LLM prompt injection. */
  getSummary(): string {
    if (this.patterns.length === 0) return "";

    // Group by templateId + failStage
    const groups = new Map<string, { count: number; reason: string; symbol: string }>();
    for (const p of this.patterns) {
      const key = `${p.templateId}|${p.failStage}`;
      const existing = groups.get(key);
      if (existing) {
        existing.count++;
      } else {
        groups.set(key, { count: 1, reason: p.failReason, symbol: p.symbol });
      }
    }

    const lines = ["## Lessons from Recent Failures"];
    for (const [key, { count, reason, symbol }] of groups) {
      const [templateId, stage] = key.split("|");
      lines.push(`- ${stage}: ${templateId} on ${symbol} failed (${reason}) x${count}`);
    }

    return lines.join("\n");
  }
}
