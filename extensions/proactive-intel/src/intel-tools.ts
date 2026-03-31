/**
 * Agent tools for the proactive-intel plugin.
 *
 * Provides:
 *   - insights: Get proactive intelligence insights based on learned patterns
 *   - my_patterns: View detected usage patterns and routines
 *   - learn_preference: Teach the system a new preference
 */

import { Type } from "@sinclair/typebox";
import type { AnticipationEngine } from "./anticipation-engine.js";
import type { PatternDetector } from "./pattern-detector.js";

export function createInsightsTool(detector: PatternDetector, engine: AnticipationEngine) {
  return {
    name: "insights",
    label: "Proactive Insights",
    description:
      "Get proactive intelligence insights based on learned interaction patterns. Shows predicted needs, routine suggestions, and contextual recommendations.",
    parameters: Type.Object({
      includePatterns: Type.Optional(
        Type.Boolean({ description: "Include raw pattern data (default: false)" }),
      ),
      deliverNow: Type.Optional(
        Type.Boolean({
          description: "Mark returned insights as delivered so they don't repeat (default: false)",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const includePatterns =
        typeof params.includePatterns === "boolean" ? params.includePatterns : false;
      const deliverNow = typeof params.deliverNow === "boolean" ? params.deliverNow : false;

      // Trigger analysis
      const allPatterns = detector.analyzePatterns();

      // Generate insights
      const insights = engine.generateInsights();
      const report = engine.formatInsightsReport(insights);

      const lines: string[] = [report];

      // Stats
      lines.push("");
      lines.push("---");
      lines.push(
        `*${detector.getInteractionCount()} interactions analyzed • ${detector.getPatternCount()} patterns detected*`,
      );

      if (includePatterns) {
        lines.push("");
        lines.push("### Detected Patterns");
        lines.push("");
        lines.push("| Pattern | Type | Confidence | Occurrences |");
        lines.push("| --- | --- | --- | --- |");
        for (const p of allPatterns.slice(0, 15)) {
          lines.push(`| ${p.description} | ${p.type} | ${p.confidence}% | ${p.occurrences} |`);
        }
      }

      if (deliverNow) {
        engine.markDelivered(insights.map((i) => i.id));
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { insights, patternCount: detector.getPatternCount() },
      };
    },
  };
}

export function createPatternsTool(detector: PatternDetector) {
  return {
    name: "my_patterns",
    label: "My Patterns",
    description:
      "View detected usage patterns, routines, and interaction habits. Shows temporal patterns, topic trends, channel preferences, and daily routines.",
    parameters: Type.Object({
      type: Type.Optional(
        Type.Unsafe<"all" | "temporal" | "topical" | "channel-pref" | "routine">({
          type: "string",
          enum: ["all", "temporal", "topical", "channel-pref", "routine"],
          description: "Filter by pattern type (default: all)",
        }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const filterType = typeof params.type === "string" ? params.type : "all";

      // Fresh analysis
      const allPatterns = detector.analyzePatterns();
      const patterns =
        filterType === "all" ? allPatterns : allPatterns.filter((p) => p.type === filterType);

      const lines: string[] = [];
      lines.push("## 📊 Your Interaction Patterns");
      lines.push("");
      lines.push(`*Based on ${detector.getInteractionCount()} interactions*`);
      lines.push("");

      if (patterns.length === 0) {
        lines.push("No patterns detected yet. Keep using OpenClaw and patterns will emerge.");
        lines.push("");
        lines.push(
          `> **Tip:** I need at least 5 repeated behaviors in the same time slot or topic to detect a pattern.`,
        );
      } else {
        // Group by type
        const groupedPatterns = new Map<string, typeof patterns>();
        for (const p of patterns) {
          const group = groupedPatterns.get(p.type) ?? [];
          group.push(p);
          groupedPatterns.set(p.type, group);
        }

        const typeLabels: Record<string, string> = {
          temporal: "⏰ Time-Based Patterns",
          topical: "💬 Recurring Topics",
          "channel-pref": "📱 Channel Preferences",
          routine: "🔄 Daily Routines",
          sequential: "➡️ Workflow Sequences",
        };

        for (const [type, grouped] of groupedPatterns) {
          lines.push(`### ${typeLabels[type] ?? type}`);
          lines.push("");

          for (const p of grouped.slice(0, 10)) {
            const confidenceBar = getConfidenceBar(p.confidence);
            lines.push(`- ${p.description}`);
            lines.push(`  ${confidenceBar} ${p.confidence}% • ${p.occurrences} occurrences`);
          }
          lines.push("");
        }
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { patterns, interactionCount: detector.getInteractionCount() },
      };
    },
  };
}

export function createLearnPreferenceTool(detector: PatternDetector) {
  return {
    name: "learn_preference",
    label: "Learn Preference",
    description:
      "Teach the system a new preference or habit. This manually records an interaction pattern to speed up learning.",
    parameters: Type.Object({
      message: Type.String({
        description: "A description of the preference or typical interaction",
      }),
      channelId: Type.Optional(
        Type.String({ description: "Channel this preference applies to (default: current)" }),
      ),
      repeat: Type.Optional(
        Type.Number({ description: "How many times to reinforce this pattern (default: 5)" }),
      ),
    }),
    async execute(_id: string, params: Record<string, unknown>) {
      const message = typeof params.message === "string" ? params.message : "";
      const channelId = typeof params.channelId === "string" ? params.channelId : "direct";
      const repeat = typeof params.repeat === "number" ? Math.min(params.repeat, 20) : 5;

      if (!message.trim()) {
        return {
          content: [{ type: "text", text: "Error: message is required" }],
        };
      }

      // Record the interaction multiple times to establish a pattern
      for (let i = 0; i < repeat; i++) {
        detector.recordInteraction({
          message,
          channelId,
          agentId: "main",
        });
      }

      // Re-analyze
      detector.analyzePatterns();

      const lines = [
        "## ✅ Preference Learned",
        "",
        `Recorded "${message}" as a preference (reinforced ${repeat} times).`,
        "",
        `Total patterns detected: ${detector.getPatternCount()}`,
        `Total interactions tracked: ${detector.getInteractionCount()}`,
      ];

      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { message, repeat, patternCount: detector.getPatternCount() },
      };
    },
  };
}

function getConfidenceBar(confidence: number): string {
  const filled = Math.round(confidence / 10);
  const empty = 10 - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}
