// ============================================================================
// Evolution Service
//
// Unified facade orchestrating the entire skill evolution lifecycle:
//   detect signals → generate experiences → approve → persist → solidify
// ============================================================================

import type { EvolutionConfig } from "./config.js";
import type { EvolutionEntry } from "./evolution-schema.js";
import { EvolutionStore } from "./evolution-store.js";
import type { GraphitiClient } from "./graphiti-client.js";
import { looksLikeInjection } from "./injection-guard.js";
import { extractMessageText } from "./message-content.js";
import { SignalDetector, type EvolutionSignal } from "./signal-detector.js";
import { SkillEvolver, type ExperienceContext } from "./skill-evolver.js";

// ============================================================================
// Types
// ============================================================================

type LlmCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
  error?: (msg: string) => void;
};

export type EvolutionResult = {
  skillName: string;
  entries: EvolutionEntry[];
  applied: boolean;
};

// ============================================================================
// Service
// ============================================================================

export class EvolutionService {
  private readonly detector: SignalDetector;
  private readonly store: EvolutionStore;
  private readonly evolver: SkillEvolver;
  private readonly config: EvolutionConfig;
  private readonly logger: Logger;

  constructor(params: {
    graphiti: GraphitiClient;
    callLlm: LlmCallFn;
    skillsBaseDir: string;
    config: EvolutionConfig;
    logger: Logger;
  }) {
    this.detector = new SignalDetector();
    this.store = new EvolutionStore(params.skillsBaseDir);
    this.evolver = new SkillEvolver(
      params.graphiti,
      params.callLlm,
      params.config.maxEntriesPerRound,
    );
    this.config = params.config;
    this.logger = params.logger;
  }

  // --------------------------------------------------------------------------
  // Auto evolution (runs post-conversation)
  // --------------------------------------------------------------------------

  /**
   * Run the full evolution pipeline on a set of messages.
   * Detects signals, groups by skill, generates experiences, and persists.
   */
  async runAutoEvolution(messages: unknown[]): Promise<EvolutionResult[]> {
    if (!this.config.enabled) return [];

    // Step 1: Detect signals
    const signals = this.detector.detect(messages);
    if (signals.length === 0) return [];

    this.logger.info(`learning-loop: detected ${signals.length} evolution signal(s)`);

    // Step 2: Group signals by skill
    const bySkill = this.groupBySkill(signals);

    // Step 3: Process each skill
    const results: EvolutionResult[] = [];
    for (const [skillName, skillSignals] of bySkill) {
      try {
        const result = await this.processSkill(skillName, skillSignals, messages);
        if (result) results.push(result);
      } catch (err) {
        this.logger.warn(`learning-loop: evolution failed for ${skillName}: ${String(err)}`);
      }
    }

    return results;
  }

  // --------------------------------------------------------------------------
  // Manual evolution (via /evolve command)
  // --------------------------------------------------------------------------

  /**
   * Manually trigger evolution for a specific skill using the conversation.
   */
  async evolveSkill(skillName: string, messages: unknown[]): Promise<EvolutionResult | null> {
    if (!this.config.enabled) return null;

    const signals = this.detector.detect(messages);
    // For manual evolution, use all signals even if no skill attribution
    const relevantSignals =
      signals.length > 0
        ? signals
        : [
            {
              type: "user_correction" as const,
              section: "Instructions" as const,
              excerpt: "Manual evolution triggered by user",
            },
          ];

    return this.processSkill(skillName, relevantSignals, messages);
  }

  // --------------------------------------------------------------------------
  // Solidification
  // --------------------------------------------------------------------------

  /**
   * Write pending body entries into a skill's SKILL.md.
   */
  async solidifySkill(skillName: string): Promise<number> {
    const count = await this.store.solidify(skillName);
    if (count > 0) {
      this.logger.info(`learning-loop: solidified ${count} entries into ${skillName}/SKILL.md`);
    }
    return count;
  }

  /**
   * Get pending entries for a skill.
   */
  getPendingEntries(skillName: string): EvolutionEntry[] {
    return this.store.getPendingEntries(skillName);
  }

  /**
   * List all skills that have evolution history.
   */
  listEvolvedSkills(): string[] {
    return this.store.listEvolvedSkills();
  }

  /**
   * Get description experiences formatted for prompt injection.
   */
  getDescriptionExperiences(skillName: string): string {
    return this.store.formatDescriptionExperiences(skillName);
  }

  /**
   * Clear signal dedup cache (call at conversation boundaries).
   */
  clearSignals(): void {
    this.detector.clearProcessedSignals();
  }

  isEnabled(): boolean {
    return this.config.enabled;
  }

  // --------------------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------------------

  private async processSkill(
    skillName: string,
    signals: EvolutionSignal[],
    messages: unknown[],
  ): Promise<EvolutionResult | null> {
    // Build context
    const context = this.buildContext(skillName, signals, messages);

    // Generate experiences via LLM
    const entries = this.filterUnsafeEntries(
      skillName,
      await this.evolver.generateExperiences(skillName, context),
    );
    if (entries.length === 0) return null;

    // Apply based on policy
    const shouldApply = this.config.approvalPolicy === "always_allow";
    for (const entry of entries) {
      if (shouldApply && entry.change.target === "description") {
        entry.applied = true;
      }
      await this.store.appendEntry(skillName, entry);
    }

    if (shouldApply) {
      this.logger.info(`learning-loop: applied ${entries.length} evolution(s) to ${skillName}`);
    }

    return {
      skillName,
      entries,
      applied: shouldApply,
    };
  }

  private filterUnsafeEntries(skillName: string, entries: EvolutionEntry[]): EvolutionEntry[] {
    return entries.filter((entry) => {
      if (!looksLikeInjection(entry.change.content)) {
        return true;
      }
      this.logger.warn(
        `learning-loop: blocked injection-like ${entry.change.target} evolution for ${skillName}`,
      );
      return false;
    });
  }

  private buildContext(
    skillName: string,
    signals: EvolutionSignal[],
    messages: unknown[],
  ): ExperienceContext {
    // Try to load current SKILL.md
    const skillContent = this.store.loadSkillMarkdown(skillName);

    // Build conversation snippet (last 30 messages, truncated)
    const snippet = this.buildConversationSnippet(messages);

    return {
      skillContent,
      signals,
      conversationSnippet: snippet,
      existingDescriptions: this.store.getExistingDescriptionEntries(skillName),
      existingBodyEntries: this.store.getExistingBodyEntries(skillName),
    };
  }

  private buildConversationSnippet(messages: unknown[], maxMessages = 30): string {
    const lines: string[] = [];
    const recent = Array.isArray(messages) ? messages.slice(-maxMessages) : [];

    for (const raw of recent) {
      if (!raw || typeof raw !== "object") continue;
      const msg = raw as Record<string, unknown>;
      const role = String(msg.role ?? "unknown");
      const content = extractMessageText(msg.content);

      if (!content) continue;

      // Truncate long messages
      const preview = content.length > 300 ? content.slice(0, 300) + "..." : content;
      lines.push(`[${role}]: ${preview}`);
    }

    return lines.join("\n");
  }

  private groupBySkill(signals: EvolutionSignal[]): Map<string, EvolutionSignal[]> {
    const groups = new Map<string, EvolutionSignal[]>();

    for (const signal of signals) {
      const skillName = signal.skillName ?? signal.toolName ?? "_general";
      const existing = groups.get(skillName) ?? [];
      existing.push(signal);
      groups.set(skillName, existing);
    }

    return groups;
  }
}
