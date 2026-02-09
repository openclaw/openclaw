/**
 * Comms agent — handles email, messaging, and drafting.
 * Uses local model for speed on simple tasks, cloud for complex composition.
 */

import type { Task } from "../types.js";
import { BaseAgent, type AgentResult } from "./base-agent.js";

export class CommsAgent extends BaseAgent {
  async execute(task: Task): Promise<AgentResult> {
    return this.runWithTracking(task, async () => {
      const { intent } = task.classification;

      switch (intent) {
        case "email_draft":
          return this.draftEmail(task);
        case "email_send":
          return this.sendEmail(task);
        case "email_read":
          return this.readEmail(task);
        case "general_chat":
          return this.chat(task);
        default:
          return this.chat(task);
      }
    });
  }

  private async draftEmail(task: Task): Promise<string> {
    // TODO: Integrate with Pi AgentSession + email tool
    return `[Draft] Would compose email based on: "${task.input}"`;
  }

  private async sendEmail(task: Task): Promise<string> {
    // TODO: Requires approval gate before sending
    return `[Send] Would send email based on: "${task.input}"`;
  }

  private async readEmail(task: Task): Promise<string> {
    // TODO: Integrate with IMAP tool
    return `[Read] Would read emails based on: "${task.input}"`;
  }

  private async chat(task: Task): Promise<string> {
    // TODO: Integrate with Pi AgentSession for general conversation
    return `[Chat] Would respond to: "${task.input}"`;
  }
}
