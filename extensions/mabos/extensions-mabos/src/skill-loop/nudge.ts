import type { SkillCreator } from "./creator.js";
import type { SkillProposal } from "./types.js";

export class SkillNudge {
  private sessionsSinceLastNudge = 0;
  private interval: number;

  constructor(
    private creator: SkillCreator,
    nudgeInterval: number = 10,
  ) {
    this.interval = nudgeInterval;
  }

  async onSessionEnd(ctx: {
    taskDescription?: string;
    toolsUsed?: string[];
    outcome?: string;
    agentId?: string;
    sessionId?: string;
  }): Promise<SkillProposal | null> {
    this.sessionsSinceLastNudge++;
    if (this.sessionsSinceLastNudge < this.interval) return null;
    this.sessionsSinceLastNudge = 0;

    if (!ctx.toolsUsed?.length || !ctx.taskDescription) return null;

    return this.creator.proposeSkill({
      taskDescription: ctx.taskDescription,
      toolsUsed: ctx.toolsUsed,
      outcome: (ctx.outcome as "success" | "partial" | "failure") ?? "success",
      agentId: ctx.agentId ?? "unknown",
      sessionId: ctx.sessionId,
    });
  }

  getSessionCount(): number {
    return this.sessionsSinceLastNudge;
  }

  reset(): void {
    this.sessionsSinceLastNudge = 0;
  }
}
