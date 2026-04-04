// ============================================================================
// Skill Evolver
//
// LLM-based skill refinement. Takes detected signals and conversation
// context, then generates evolution entries via an LLM call.
// The LLM decides relevance, deduplication, and content generation.
// ============================================================================

import {
  createEvolutionEntry,
  type EvolutionChange,
  type EvolutionEntry,
} from "./evolution-schema.js";
import type { GraphitiClient } from "./graphiti-client.js";
import type { EvolutionSignal } from "./signal-detector.js";

// ============================================================================
// Types
// ============================================================================

export type ExperienceContext = {
  /** Current SKILL.md content (if available) */
  skillContent?: string;
  /** Detected signals for this skill */
  signals: EvolutionSignal[];
  /** Recent conversation messages (last N, truncated) */
  conversationSnippet: string;
  /** Existing description-layer experiences (for dedup) */
  existingDescriptions: Array<{ id: string; content: string }>;
  /** Existing body-layer entries (for dedup) */
  existingBodyEntries: Array<{ id: string; content: string }>;
};

type LlmCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

// ============================================================================
// Evolver
// ============================================================================

export class SkillEvolver {
  constructor(
    private readonly graphiti: GraphitiClient,
    private readonly callLlm: LlmCallFn,
    private readonly maxEntriesPerRound: number = 2,
  ) {}

  /**
   * Generate skill experience entries from signals and context.
   * Returns a list of EvolutionEntry objects (max maxEntriesPerRound).
   */
  async generateExperiences(
    skillName: string,
    context: ExperienceContext,
  ): Promise<EvolutionEntry[]> {
    const systemPrompt = this.buildSystemPrompt();
    const userPrompt = this.buildUserPrompt(skillName, context);

    const rawResponse = await this.callLlm(systemPrompt, userPrompt);
    const parsed = this.parseResponse(rawResponse);
    const resolved = parsed.length > 0 ? parsed : this.buildFallbackEntries(skillName, context);

    // Store the evolution context in the knowledge graph for long-term learning
    if (resolved.length > 0) {
      try {
        await this.graphiti.addObservation(
          "skill_evolution",
          `Skill "${skillName}" refined: ${resolved.map((e) => e.change.content.slice(0, 80)).join("; ")}`,
          context.signals.map((s) => s.excerpt.slice(0, 50)).join("; "),
        );
      } catch {
        // Non-fatal: knowledge graph storage is best-effort
      }
    }

    return resolved.slice(0, this.maxEntriesPerRound);
  }

  // --------------------------------------------------------------------------
  // Prompt construction
  // --------------------------------------------------------------------------

  private buildSystemPrompt(): string {
    return `You are a skill evolution analyst. Your job is to analyze conversation signals (errors, user corrections) and generate improvements for agent skills.

DECISION FLOWCHART:
1. RELEVANCE: Is this signal about the skill's domain? If clearly unrelated (external service outage, user typo, etc.), output action: "skip" with skip_reason: "irrelevant".
2. DEDUPLICATION: Is this insight already captured in existing experiences? If yes, output action: "skip" with skip_reason: "duplicate". If partially overlapping, output action: "replace" with merge_target set to the id of the entry to replace.
3. PRIORITY: Is this high-impact enough to warrant a skill update? Low-value signals get action: "skip" with skip_reason: "low_priority".
4. GENERATE: Create a concise, reusable rule or insight.

OUTPUT FORMAT:
Return a JSON array of objects. Each object has:
- section: "Instructions" | "Examples" | "Troubleshooting"
- action: "append" | "replace" | "skip"
- content: Markdown text (the improvement to add)
- target: "description" (prompt metadata) | "body" (SKILL.md content)
- skip_reason: "irrelevant" | "duplicate" | "low_priority" (only when action is "skip")
- merge_target: id of existing entry to replace (prefer the provided ev_xxxxxxxx id; numeric indexes are legacy fallback only)
- source_signal: "execution_failure" | "user_correction"
- context_summary: Brief summary of what triggered this

RULES:
- Generate at most ${this.maxEntriesPerRound} entries per call
- Content should be concise, reusable rules/insights (not conversation-specific)
- Use the same language as the skill content
- Format content as markdown
- Prefer "Instructions" for behavioral rules, "Troubleshooting" for error recovery, "Examples" for patterns
- "description" target entries are injected into prompts; keep them brief (1-2 sentences)
- "body" target entries are written to SKILL.md; can be longer with examples`;
  }

  private buildUserPrompt(skillName: string, context: ExperienceContext): string {
    const parts: string[] = [];

    parts.push(`# Skill: ${skillName}`);

    if (context.skillContent) {
      parts.push(
        `\n## Current SKILL.md Content:\n\`\`\`\n${context.skillContent.slice(0, 2000)}\n\`\`\``,
      );
    }

    parts.push(`\n## Detected Signals:`);
    for (const signal of context.signals) {
      parts.push(`- [${signal.type}] ${signal.excerpt}`);
      if (signal.toolName) {
        parts.push(`  Tool: ${signal.toolName}`);
      }
    }

    parts.push(`\n## Recent Conversation:\n\`\`\`\n${context.conversationSnippet}\n\`\`\``);

    if (context.existingDescriptions.length > 0) {
      parts.push(`\n## Existing Description Experiences (check for duplicates):`);
      context.existingDescriptions.forEach((entry) => {
        parts.push(`- ${entry.id}: ${entry.content}`);
      });
    }

    if (context.existingBodyEntries.length > 0) {
      parts.push(`\n## Existing Body Entries (check for duplicates):`);
      context.existingBodyEntries.forEach((entry) => {
        parts.push(`- ${entry.id}: ${entry.content}`);
      });
    }

    parts.push(
      `\nAnalyze the signals and conversation, then output a JSON array of evolution entries.`,
    );
    return parts.join("\n");
  }

  // --------------------------------------------------------------------------
  // Response parsing
  // --------------------------------------------------------------------------

  private parseResponse(raw: string): EvolutionEntry[] {
    const entries: EvolutionEntry[] = [];

    // Extract JSON from response (may be wrapped in markdown code fences)
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? raw.match(/(\[[\s\S]*\])/);
    if (!jsonMatch) {
      return entries;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonMatch[1]);
    } catch {
      return entries;
    }

    const items = Array.isArray(parsed) ? parsed : [parsed];

    for (const item of items) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;

      // Skip entries with skip action
      if (obj.action === "skip") continue;

      const change: EvolutionChange = {
        section: (obj.section as EvolutionChange["section"]) ?? "Instructions",
        action: (obj.action as EvolutionChange["action"]) ?? "append",
        content: String(obj.content ?? ""),
        target: (obj.target as EvolutionChange["target"]) ?? "body",
        skipReason: obj.skip_reason as EvolutionChange["skipReason"],
        mergeTarget:
          typeof obj.merge_target === "number"
            ? String(obj.merge_target)
            : (obj.merge_target as string | undefined),
      };

      if (!change.content.trim()) continue;

      const entry = createEvolutionEntry(
        (obj.source_signal as EvolutionSignal["type"]) ?? "execution_failure",
        String(obj.context_summary ?? ""),
        change,
      );

      entries.push(entry);
    }

    return entries;
  }

  private buildFallbackEntries(skillName: string, context: ExperienceContext): EvolutionEntry[] {
    for (const signal of context.signals) {
      if (signal.type !== "user_correction") {
        continue;
      }

      const content = this.extractCorrectionRule(signal.excerpt, skillName);
      if (!content) {
        continue;
      }
      if (this.isDuplicateFallback(content, context)) {
        continue;
      }

      const target: EvolutionChange["target"] = /SKILL\.md|\.agents\/skills\//i.test(signal.excerpt)
        ? "body"
        : "description";

      return [
        createEvolutionEntry(signal.type, "Direct user correction targeted to the skill.", {
          section: "Instructions",
          action: "append",
          content,
          target,
        }),
      ];
    }

    return [];
  }

  private extractCorrectionRule(excerpt: string, skillName: string): string | null {
    let text = excerpt.replace(/\s+/g, " ").trim();
    if (!text) {
      return null;
    }

    text = text.replace(/\breply only with ok\.?$/i, "").trim();
    text = text.replace(
      new RegExp(
        `(?:in\\s+)?\\.agents/skills/${this.escapeRegExp(skillName)}/SKILL\\.md\\.?\\s*`,
        "ig",
      ),
      "",
    );
    text = text.replace(/\bthat'?s\s+(?:not\s+)?(?:wrong|incorrect)\.?\s*/i, "");
    text = text.replace(/^no,?\s*/i, "");

    const conditionalUse = text.match(/\bwhen ([^,]+), use ([^.,]+) instead of ([^.,]+)(?:[.]|$)/i);
    if (conditionalUse) {
      return this.finishSentence(
        `Use ${conditionalUse[2]} instead of ${conditionalUse[3]} when ${conditionalUse[1]}`,
      );
    }

    const imperativeMatch = text.match(
      /\b(?:you should|should|prefer to|prefer|use|avoid|always|never)\b[\s,:-]*(.+)$/i,
    );
    if (imperativeMatch) {
      const normalized = imperativeMatch[0]
        .replace(/^you should\b[\s,:-]*/i, "")
        .replace(/^should\b[\s,:-]*/i, "")
        .trim();
      return normalized ? this.finishSentence(normalized) : null;
    }

    const insteadMatch = text.match(/\b(use|prefer) ([^.,]+) instead of ([^.,]+)(?:[.]|$)/i);
    if (insteadMatch) {
      return this.finishSentence(
        `${this.capitalize(insteadMatch[1])} ${insteadMatch[2]} instead of ${insteadMatch[3]}`,
      );
    }

    return null;
  }

  private isDuplicateFallback(content: string, context: ExperienceContext): boolean {
    const normalized = this.normalizeForDedup(content);
    if (!normalized) {
      return true;
    }

    const existing = [
      ...context.existingDescriptions.map((entry) => entry.content),
      ...context.existingBodyEntries.map((entry) => entry.content),
      context.skillContent ?? "",
    ];
    return existing.some((entry) => this.normalizeForDedup(entry).includes(normalized));
  }

  private normalizeForDedup(content: string): string {
    return content
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  }

  private finishSentence(content: string): string {
    const trimmed = content.trim().replace(/[.;:,]+$/g, "");
    if (!trimmed) {
      return "";
    }
    return `${this.capitalize(trimmed)}.`;
  }

  private capitalize(content: string): string {
    if (!content) {
      return content;
    }
    return content.charAt(0).toUpperCase() + content.slice(1);
  }

  private escapeRegExp(content: string): string {
    return content.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
}
