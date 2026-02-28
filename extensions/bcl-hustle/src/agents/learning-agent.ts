/**
 * Learning Agent
 *
 * Analyzes successes/failures and updates brain.md
 */

import type { OpenClawPluginApi } from "../../../../src/plugins/types.js";
import { getDecisions, getMemory, saveMemory, getProjects } from "../db/database.js";
import { type MemoryEntry } from "../types/index.js";

export class LearningAgent {
  private api: OpenClawPluginApi;

  constructor(api: OpenClawPluginApi) {
    this.api = api;
  }

  async execute(): Promise<void> {
    this.api.logger.info("Learning Agent: Running learning loop...");

    try {
      await this.analyzeDecisions();
      await this.analyzeProjects();
      await this.updateBrain();

      this.api.logger.info("Learning Agent: Completed");
    } catch (error) {
      this.api.logger.error("Learning Agent failed" + String(error));
      throw error;
    }
  }

  private async analyzeDecisions(): Promise<void> {
    const decisions = getDecisions(50);

    const successful = decisions.filter((d) => d.confidence > 0.85);
    const failed = decisions.filter((d) => d.confidence < 0.5);

    this.api.logger.info(
      `Learning: ${successful.length} successful, ${failed.length} failed decisions`,
    );
  }

  private async analyzeProjects(): Promise<void> {
    const projects = getProjects();
    const successful = projects.filter((p) => p.status === "deployed" && p.revenue > 0);
    const failed = projects.filter((p) => p.status === "failed");

    this.api.logger.info(
      `Learning: ${successful.length} successful, ${failed.length} failed projects`,
    );
  }

  private async updateBrain(): Promise<void> {
    const learning: MemoryEntry = {
      id: `memory_${Date.now()}`,
      category: "learning",
      content: `Daily learning loop completed at ${new Date().toISOString()}`,
      tags: ["daily", "learning"],
      timestamp: new Date(),
    };

    saveMemory(learning);
    this.api.logger.info("Learning: Brain.md updated");
  }
}
