/**
 * Coder agent — handles code editing, testing, and deployment.
 * Uses cloud model for code quality. Pi's built-in tools (read/edit/write/bash) come free.
 */

import type { Task } from "../types.js";
import { BaseAgent, type AgentResult } from "./base-agent.js";

export class CoderAgent extends BaseAgent {
  async execute(task: Task): Promise<AgentResult> {
    return this.runWithTracking(task, async () => {
      const { intent } = task.classification;

      switch (intent) {
        case "code_simple":
        case "code_complex":
          return this.code(task);
        case "deploy":
          return this.deploy(task);
        default:
          return this.code(task);
      }
    });
  }

  private async code(task: Task): Promise<string> {
    // TODO: Integrate with Pi AgentSession
    // Pi provides read/edit/write/bash tools for free
    return `[Code] Would execute coding task: "${task.input}"`;
  }

  private async deploy(task: Task): Promise<string> {
    // TODO: Requires approval before deploying
    return `[Deploy] Would deploy: "${task.input}" (requires approval)`;
  }
}
