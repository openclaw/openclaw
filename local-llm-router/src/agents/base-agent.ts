/**
 * Base agent interface.
 *
 * Each agent (comms, browser, coder, monitor) extends this.
 * Wraps a model call with scoped tools, audit logging, and error capture.
 */

import type { AgentId, AgentConfig, Task, AuditEntry } from "../types.js";
import { AuditLog } from "../persistence/audit.js";
import { ErrorJournal } from "../errors/journal.js";

export interface AgentDeps {
  auditLog: AuditLog;
  errorJournal: ErrorJournal;
  projectRoot: string;
}

export interface AgentResult {
  success: boolean;
  output: string;
  error?: string;
  durationMs: number;
}

export abstract class BaseAgent {
  readonly id: AgentId;
  readonly config: AgentConfig;
  protected deps: AgentDeps;

  constructor(id: AgentId, config: AgentConfig, deps: AgentDeps) {
    this.id = id;
    this.config = config;
    this.deps = deps;
  }

  /**
   * Execute a task. Each agent subclass implements this.
   */
  abstract execute(task: Task): Promise<AgentResult>;

  /**
   * Check if this agent can handle a given tool.
   */
  canUseTool(toolName: string): boolean {
    return this.config.tools.includes(toolName);
  }

  /**
   * Check if an action requires user approval.
   */
  requiresApproval(action: string): boolean {
    return this.config.approvalRequired.includes(action);
  }

  /**
   * Log an action to the audit trail.
   */
  protected async audit(
    entry: Omit<AuditEntry, "timestamp" | "agent">,
  ): Promise<void> {
    await this.deps.auditLog.log({
      agent: this.id,
      ...entry,
    });
  }

  /**
   * Capture an error to the error journal.
   */
  protected async captureError(params: {
    type: Parameters<ErrorJournal["capture"]>[0]["type"];
    skill?: string;
    model: string;
    task: string;
    context: Record<string, unknown>;
    screenshotPath?: string;
    sessionRef?: string;
  }): Promise<void> {
    await this.deps.errorJournal.capture({
      agent: this.id,
      ...params,
    });
  }

  /**
   * Run with timing and error handling.
   */
  protected async runWithTracking(
    task: Task,
    fn: () => Promise<string>,
  ): Promise<AgentResult> {
    const start = Date.now();

    try {
      await this.audit({
        action: "task_start",
        input: { taskId: task.id, intent: task.classification.intent },
      });

      const output = await fn();

      const durationMs = Date.now() - start;
      await this.audit({
        action: "task_complete",
        output: output.slice(0, 500), // Truncate for audit
        durationMs,
      });

      return { success: true, output, durationMs };
    } catch (err) {
      const durationMs = Date.now() - start;
      const error = err instanceof Error ? err.message : String(err);

      await this.audit({
        action: "task_error",
        error,
        durationMs,
      });

      await this.captureError({
        type: "tool_failure",
        model: `${task.route.model}`,
        task: task.input,
        context: { error, intent: task.classification.intent },
      });

      return { success: false, output: "", error, durationMs };
    }
  }
}
