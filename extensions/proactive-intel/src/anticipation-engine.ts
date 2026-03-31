/**
 * Anticipation engine — predicts what the user likely needs based on
 * current context and learned patterns.
 *
 * Generates proactive suggestions that can be:
 *   1. Injected into the system prompt for context enrichment
 *   2. Surfaced as proactive notifications during heartbeat
 *   3. Queried on-demand via the insights tool
 */

import type { DetectedPattern, PatternDetector } from "./pattern-detector.js";

export type ProactiveInsight = {
  id: string;
  type: InsightType;
  priority: "low" | "medium" | "high";
  title: string;
  description: string;
  actionable: boolean;
  suggestedPrompt?: string;
  basedOn: string[];
  confidence: number;
  timestamp: number;
};

export type InsightType =
  | "routine-prep"     // Prepare for upcoming routine
  | "topic-reminder"   // Remind about recurring topic
  | "workflow-suggest" // Suggest next step in a workflow
  | "time-sensitive"   // Time-based opportunity
  | "follow-up"        // Follow-up on previous conversation
  | "optimization";    // Usage optimization suggestion

export class AnticipationEngine {
  private detector: PatternDetector;
  private generatedInsights: Map<string, ProactiveInsight> = new Map();
  private deliveredInsightIds = new Set<string>();

  constructor(detector: PatternDetector) {
    this.detector = detector;
  }

  /**
   * Generate proactive insights based on current context and learned patterns.
   */
  generateInsights(context?: {
    dayOfWeek?: number;
    hourOfDay?: number;
    channelId?: string;
  }): ProactiveInsight[] {
    const now = new Date();
    const currentDay = context?.dayOfWeek ?? now.getDay();
    const currentHour = context?.hourOfDay ?? now.getHours();

    const relevantPatterns = this.detector.getRelevantPatterns({
      dayOfWeek: currentDay,
      hourOfDay: currentHour,
      channelId: context?.channelId,
    });

    const insights: ProactiveInsight[] = [];

    for (const pattern of relevantPatterns) {
      const insight = this.patternToInsight(pattern, currentHour);
      if (insight && !this.deliveredInsightIds.has(insight.id)) {
        insights.push(insight);
        this.generatedInsights.set(insight.id, insight);
      }
    }

    // Add time-sensitive insights
    insights.push(...this.generateTimeSensitiveInsights(currentDay, currentHour));

    return insights.sort((a, b) => {
      const priorityOrder = { high: 3, medium: 2, low: 1 };
      return priorityOrder[b.priority] - priorityOrder[a.priority];
    });
  }

  /**
   * Mark insights as delivered so they don't repeat.
   */
  markDelivered(insightIds: string[]): void {
    for (const id of insightIds) {
      this.deliveredInsightIds.add(id);
    }
  }

  /**
   * Reset delivered tracking (e.g., at the start of a new day).
   */
  resetDelivered(): void {
    this.deliveredInsightIds.clear();
  }

  /**
   * Get a formatted string for system prompt injection.
   */
  getContextEnrichment(): string {
    const insights = this.generateInsights();
    if (insights.length === 0) {
      return "";
    }

    const lines = [
      "## Proactive Intelligence",
      "",
      "Based on learned user patterns, the following may be relevant right now:",
      "",
    ];

    for (const insight of insights.slice(0, 5)) {
      const priority = insight.priority === "high" ? "🔴" : insight.priority === "medium" ? "🟡" : "🟢";
      lines.push(`${priority} **${insight.title}** — ${insight.description}`);
      if (insight.suggestedPrompt) {
        lines.push(`  💡 Suggest: "${insight.suggestedPrompt}"`);
      }
    }

    return lines.join("\n");
  }

  /**
   * Format insights as a user-facing report.
   */
  formatInsightsReport(insights: ProactiveInsight[]): string {
    if (insights.length === 0) {
      return "No proactive insights available yet. Keep interacting and I'll learn your patterns.";
    }

    const lines: string[] = [];
    lines.push("## 🧠 Proactive Insights");
    lines.push("");

    for (const insight of insights) {
      const priority = insight.priority === "high" ? "🔴" : insight.priority === "medium" ? "🟡" : "🟢";
      lines.push(`### ${priority} ${insight.title}`);
      lines.push(insight.description);
      if (insight.suggestedPrompt) {
        lines.push(`> 💡 **Try:** "${insight.suggestedPrompt}"`);
      }
      lines.push(`*Confidence: ${insight.confidence}% | Based on: ${insight.basedOn.join(", ")}*`);
      lines.push("");
    }

    return lines.join("\n");
  }

  // ── Private ────────────────────────────────────────────────────────────

  private patternToInsight(
    pattern: DetectedPattern,
    currentHour: number,
  ): ProactiveInsight | null {
    const ts = Date.now();
    const dayKey = new Date(ts).toISOString().slice(0, 10);

    switch (pattern.type) {
      case "temporal":
        return {
          id: `temporal:${pattern.id}:${dayKey}`,
          type: "routine-prep",
          priority: pattern.confidence >= 70 ? "high" : "medium",
          title: "Pattern Match",
          description: pattern.description,
          actionable: true,
          suggestedPrompt: pattern.suggestedAction,
          basedOn: [`${pattern.occurrences} occurrences in this time slot`],
          confidence: pattern.confidence,
          timestamp: ts,
        };

      case "topical":
        return {
          id: `topical:${pattern.id}:${dayKey}`,
          type: "topic-reminder",
          priority: "low",
          title: "Recurring Topic",
          description: pattern.description,
          actionable: false,
          basedOn: [`${pattern.occurrences} mentions`],
          confidence: pattern.confidence,
          timestamp: ts,
        };

      case "routine": {
        // Only suggest routine prep when it's 30min before the routine window
        const trigger = pattern.trigger;
        if (trigger.hourRange) {
          const [start] = trigger.hourRange;
          if (currentHour === start - 1 || currentHour === start) {
            return {
              id: `routine:${pattern.id}:${dayKey}`,
              type: "routine-prep",
              priority: "high",
              title: "Routine Approaching",
              description: `${pattern.description}. Should I help prepare?`,
              actionable: true,
              suggestedPrompt: pattern.suggestedAction,
              basedOn: [`${pattern.occurrences} routine occurrences`],
              confidence: pattern.confidence,
              timestamp: ts,
            };
          }
        }
        return null;
      }

      case "channel-pref":
        return {
          id: `channel:${pattern.id}:${dayKey}`,
          type: "optimization",
          priority: "low",
          title: "Channel Preference",
          description: pattern.description,
          actionable: false,
          basedOn: [`${pattern.occurrences} interactions`],
          confidence: pattern.confidence,
          timestamp: ts,
        };

      default:
        return null;
    }
  }

  private generateTimeSensitiveInsights(
    dayOfWeek: number,
    hourOfDay: number,
  ): ProactiveInsight[] {
    const insights: ProactiveInsight[] = [];
    const dayKey = new Date().toISOString().slice(0, 10);

    // Monday morning — week planning
    if (dayOfWeek === 1 && hourOfDay >= 8 && hourOfDay <= 10) {
      const id = `time:monday-planning:${dayKey}`;
      if (!this.deliveredInsightIds.has(id)) {
        insights.push({
          id,
          type: "time-sensitive",
          priority: "medium",
          title: "Monday Planning",
          description: "Start of the week — good time to review priorities and plan ahead.",
          actionable: true,
          suggestedPrompt: "Help me plan this week's priorities",
          basedOn: ["weekly cycle"],
          confidence: 60,
          timestamp: Date.now(),
        });
      }
    }

    // Friday afternoon — weekly review
    if (dayOfWeek === 5 && hourOfDay >= 15 && hourOfDay <= 17) {
      const id = `time:friday-review:${dayKey}`;
      if (!this.deliveredInsightIds.has(id)) {
        insights.push({
          id,
          type: "time-sensitive",
          priority: "medium",
          title: "Weekly Review",
          description: "End of week — good time to review what was accomplished.",
          actionable: true,
          suggestedPrompt: "Help me review what I accomplished this week",
          basedOn: ["weekly cycle"],
          confidence: 55,
          timestamp: Date.now(),
        });
      }
    }

    return insights;
  }
}
