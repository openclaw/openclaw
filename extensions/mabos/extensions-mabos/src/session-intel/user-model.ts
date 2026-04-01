/**
 * Dialectic user profile builder.
 *
 * Periodically analyzes recent sessions to build and refine a user profile
 * that captures communication style, domain expertise, workflow preferences,
 * and decision patterns — enabling personalized agent responses.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { IndexedSession } from "./types.js";

export interface UserModelConfig {
  profilePath: string;
  updateInterval: number;
}

interface SessionSummary {
  title: string | null;
  summary: string | null;
  agentId: string;
  startedAt: number;
  messageCount: number;
}

export class UserModel {
  private profilePath: string;
  private updateInterval: number;
  private sessionsSinceUpdate = 0;

  constructor(config: UserModelConfig) {
    this.profilePath = config.profilePath;
    this.updateInterval = config.updateInterval;
  }

  /**
   * Called at session end. Tracks session count and triggers profile update
   * after N sessions.
   */
  async onSessionEnd(session: SessionSummary): Promise<boolean> {
    this.sessionsSinceUpdate++;

    if (this.sessionsSinceUpdate < this.updateInterval) {
      return false;
    }

    this.sessionsSinceUpdate = 0;
    return true; // Signal that update is due
  }

  /**
   * Build the LLM prompt for profile update.
   * Returns the prompt string to be sent to a model for profile generation.
   */
  buildUpdatePrompt(currentProfile: string | null, recentSessions: SessionSummary[]): string {
    const sessionBlock = recentSessions
      .map((s) => {
        const title = s.title ?? "Untitled session";
        const summary = s.summary ?? "(no summary)";
        return `- ${title} (agent: ${s.agentId}, ${s.messageCount} messages): ${summary}`;
      })
      .join("\n");

    return `You are building a profile of the user based on their interactions with an AI agent system.

Current profile:
${currentProfile || "(empty — first time)"}

Recent session summaries:
${sessionBlock}

Update the profile with new observations about:
- Communication style (terse vs. detailed, technical level)
- Domain expertise (what they know well, what they're learning)
- Workflow preferences (how they like tasks done)
- Decision patterns (risk tolerance, speed vs. quality)
- Recurring topics/interests

Return the updated profile in markdown format.
Do NOT include speculative or judgmental content.
Keep the profile concise (under 500 words).`;
  }

  /**
   * Read the current user profile from disk.
   */
  async readProfile(): Promise<string | null> {
    try {
      return await readFile(this.profilePath, "utf-8");
    } catch {
      return null;
    }
  }

  /**
   * Write the updated profile to disk.
   */
  async writeProfile(content: string): Promise<void> {
    await mkdir(dirname(this.profilePath), { recursive: true });
    await writeFile(this.profilePath, content, "utf-8");
  }

  /**
   * Build system prompt section for profile injection.
   * Returns null if no profile exists.
   */
  async getProfileSection(): Promise<string | null> {
    const profile = await this.readProfile();
    if (!profile) return null;

    return `## User Profile
${profile}
Use this profile to tailor responses and work style.`;
  }
}
