/**
 * Skill prompt injector — injects relevant skills into the agent's
 * system prompt based on current task context.
 */

import type { SkillRegistry } from "./registry.js";
import type { SkillLoopConfig, SkillEntry } from "./types.js";

export interface InjectionContext {
  taskHint?: string;
  agentRole?: string;
  recentToolNames?: string[];
}

export class SkillInjector {
  private registry: SkillRegistry;
  private maxSkills: number;

  constructor(registry: SkillRegistry, config?: SkillLoopConfig) {
    this.registry = registry;
    this.maxSkills = config?.maxSkillsInPrompt ?? 5;
  }

  /**
   * Find skills relevant to the current context and return formatted
   * injection blocks.
   */
  async getRelevantSkills(ctx: InjectionContext): Promise<SkillEntry[]> {
    await this.registry.scan();

    const candidates: Array<{ skill: SkillEntry; score: number }> = [];

    for (const skill of this.registry.list()) {
      let score = 0;

      // Match by task description
      if (ctx.taskHint) {
        const hint = ctx.taskHint.toLowerCase();
        if (skill.manifest.description.toLowerCase().includes(hint)) score += 3;
        if (skill.manifest.tags.some((t) => hint.includes(t.toLowerCase()))) score += 2;
        if (skill.name.toLowerCase().includes(hint)) score += 2;
      }

      // Match by agent role
      if (ctx.agentRole && skill.manifest.applicableRoles?.length) {
        if (
          skill.manifest.applicableRoles.some(
            (r) => r.toLowerCase() === ctx.agentRole!.toLowerCase(),
          )
        ) {
          score += 3;
        }
      }

      // Match by recently used tools
      if (ctx.recentToolNames?.length && skill.manifest.toolsRequired?.length) {
        const overlap = skill.manifest.toolsRequired.filter((t) =>
          ctx.recentToolNames!.includes(t),
        );
        score += overlap.length * 2;
      }

      if (score > 0) {
        candidates.push({ skill, score });
      }
    }

    // Sort by score descending, take top N
    candidates.sort((a, b) => b.score - a.score);
    return candidates.slice(0, this.maxSkills).map((c) => c.skill);
  }

  /**
   * Format skills as injection blocks for the agent prompt.
   */
  formatForPrompt(skills: SkillEntry[]): string[] {
    return skills.map((skill) => `[SKILL: ${skill.name}]\n${skill.content}`);
  }
}
