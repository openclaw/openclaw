// ============================================================================
// Nudge Manager
//
// Turn-based counter system that triggers background memory and skill
// reviews after N conversation turns. Inspired by Hermes Agent's nudge
// mechanism. Reviews run after the response is delivered, never blocking
// the user's immediate interaction.
// ============================================================================

import type { NudgeConfig } from "./config.js";
import type { EvolutionService } from "./evolution-service.js";
import type { GraphitiClient } from "./graphiti-client.js";
import { looksLikeInjection } from "./injection-guard.js";
import { extractMessageText } from "./message-content.js";

// ============================================================================
// Types
// ============================================================================

type Logger = {
  info: (msg: string) => void;
  warn: (msg: string) => void;
};

type LlmCallFn = (systemPrompt: string, userPrompt: string) => Promise<string>;

export type NudgeAction = "memory_review" | "skill_review" | "both";

// ============================================================================
// Review prompts
// ============================================================================

const MEMORY_REVIEW_PROMPT = `Review the conversation above and determine if anything should be saved to long-term memory.

Focus on:
1. Has the user revealed things about themselves — persona, preferences, personal details worth remembering?
2. Has the user expressed expectations about behavior, work style, or how they want you to operate?
3. Are there project facts, decisions, or context that would be valuable in future conversations?
4. Are there technical patterns, API endpoints, or environment details that keep coming up?

For each item worth saving, output a JSON array of objects with:
- category: "user_profile" | "preference" | "project_fact" | "technical" | "workflow"
- observation: The concise fact or preference to store
- importance: 0.0-1.0 (how likely this is to be useful later)

If nothing is worth saving, output an empty array: []`;

const SKILL_REVIEW_PROMPT = `Review the conversation above and determine if any agent skills should be created or updated.

Focus on:
1. Was a non-trivial approach used that required trial and error?
2. Did the user expect or desire a different method or outcome?
3. Was a reusable pattern or workflow discovered?
4. Did an error require a workaround that should be documented?

For each skill improvement, output a JSON array of objects with:
- skill_name: Name of the skill to create or update (lowercase, hyphens)
- action: "create" | "update"
- content: The improvement or new skill content (markdown)
- section: "Instructions" | "Examples" | "Troubleshooting"
- reason: Why this improvement matters

If nothing warrants a skill change, output an empty array: []`;

// ============================================================================
// Manager
// ============================================================================

export class NudgeManager {
  private turnsSinceMemory = 0;
  private turnsSinceSkill = 0;
  private pendingReview: Promise<void> | null = null;

  constructor(
    private readonly graphiti: GraphitiClient,
    private readonly evolutionService: EvolutionService,
    private readonly callLlm: LlmCallFn,
    private readonly config: NudgeConfig,
    private readonly logger: Logger,
  ) {}

  /**
   * Increment turn counter and check if a nudge should fire.
   * Call this after each agent response is delivered.
   */
  checkNudge(messages: unknown[]): NudgeAction | null {
    if (!this.config.enabled) return null;

    this.turnsSinceMemory++;
    if (this.evolutionService.isEnabled()) {
      this.turnsSinceSkill++;
    }

    const memoryDue =
      this.config.memoryInterval > 0 && this.turnsSinceMemory >= this.config.memoryInterval;
    const skillDue =
      this.evolutionService.isEnabled() &&
      this.config.skillInterval > 0 &&
      this.turnsSinceSkill >= this.config.skillInterval;

    if (!memoryDue && !skillDue) return null;

    // If a review is already running, keep the accumulated counters so the next
    // check can fire immediately after the background work finishes.
    if (this.pendingReview) return null;

    const action: NudgeAction =
      memoryDue && skillDue ? "both" : memoryDue ? "memory_review" : "skill_review";

    if (memoryDue) this.turnsSinceMemory = 0;
    if (skillDue) this.turnsSinceSkill = 0;

    // Fire background review (non-blocking)
    this.spawnBackgroundReview(action, messages);

    return action;
  }

  /**
   * Reset a specific counter (call when the user manually uses memory/skill tools).
   */
  resetCounter(type: "memory" | "skill"): void {
    if (type === "memory") this.turnsSinceMemory = 0;
    else this.turnsSinceSkill = 0;
  }

  /**
   * Reset all counters (call at session boundaries).
   */
  resetAll(): void {
    this.turnsSinceMemory = 0;
    this.turnsSinceSkill = 0;
  }

  async drainPendingReview(): Promise<void> {
    await this.pendingReview;
  }

  // --------------------------------------------------------------------------
  // Background review
  // --------------------------------------------------------------------------

  private spawnBackgroundReview(action: NudgeAction, messages: unknown[]): void {
    // Don't stack reviews
    if (this.pendingReview) return;

    const snippet = this.buildSnippet(messages);

    this.pendingReview = this.runReview(action, snippet, messages)
      .catch((err) => {
        this.logger.warn(`learning-loop: background review failed: ${String(err)}`);
      })
      .finally(() => {
        this.pendingReview = null;
      });
  }

  private async runReview(
    action: NudgeAction,
    snippet: string,
    messages: unknown[],
  ): Promise<void> {
    if (action === "memory_review" || action === "both") {
      await this.runMemoryReview(snippet);
    }

    if (this.evolutionService.isEnabled() && (action === "skill_review" || action === "both")) {
      await this.runSkillReview(snippet, messages);
    }
  }

  private async runMemoryReview(snippet: string): Promise<void> {
    this.logger.info("learning-loop: running background memory review");

    const response = await this.callLlm(
      MEMORY_REVIEW_PROMPT,
      `Conversation to review:\n\n${snippet}`,
    );

    const items = this.parseJsonArray(response);
    if (items.length === 0) return;

    let stored = 0;
    for (const item of items.slice(0, 5)) {
      const category = String(item.category ?? "other");
      const observation = String(item.observation ?? "");
      const importance = Number(item.importance ?? 0.5);

      if (!observation || importance < 0.3 || looksLikeInjection(observation)) continue;

      try {
        await this.graphiti.addObservation(category, observation);
        stored++;
      } catch (err) {
        this.logger.warn(`learning-loop: failed to store observation: ${String(err)}`);
      }
    }

    if (stored > 0) {
      this.logger.info(`learning-loop: memory review stored ${stored} observation(s)`);
    }
  }

  private async runSkillReview(snippet: string, messages: unknown[]): Promise<void> {
    this.logger.info("learning-loop: running background skill review");

    const response = await this.callLlm(
      SKILL_REVIEW_PROMPT,
      `Conversation to review:\n\n${snippet}`,
    );

    const items = this.parseJsonArray(response);
    if (items.length === 0) return;

    for (const item of items.slice(0, 3)) {
      const skillName = String(item.skill_name ?? "");
      if (!skillName) continue;

      try {
        await this.evolutionService.evolveSkill(skillName, messages);
      } catch (err) {
        this.logger.warn(`learning-loop: skill review failed for ${skillName}: ${String(err)}`);
      }
    }
  }

  // --------------------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------------------

  private buildSnippet(messages: unknown[], maxMessages = 30): string {
    const lines: string[] = [];
    const recent = Array.isArray(messages) ? messages.slice(-maxMessages) : [];

    for (const raw of recent) {
      if (!raw || typeof raw !== "object") continue;
      const msg = raw as Record<string, unknown>;
      const role = String(msg.role ?? "unknown");
      const content = extractMessageText(msg.content);

      if (!content) continue;
      const preview = content.length > 300 ? content.slice(0, 300) + "..." : content;
      lines.push(`[${role}]: ${preview}`);
    }

    return lines.join("\n");
  }

  private parseJsonArray(raw: string): Array<Record<string, unknown>> {
    const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/) ?? raw.match(/(\[[\s\S]*\])/);
    if (!jsonMatch) return [];

    try {
      const parsed = JSON.parse(jsonMatch[1]);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}
