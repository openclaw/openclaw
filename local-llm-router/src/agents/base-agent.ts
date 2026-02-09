/**
 * Base agent interface.
 *
 * Each agent (comms, browser, coder, monitor) extends this.
 * Wraps a model call with scoped tools, audit logging, and error capture.
 */

import type { AgentId, AgentConfig, Task, AuditEntry, ModelRef, ModelsRegistry } from "../types.js";
import { AuditLog } from "../persistence/audit.js";
import { ErrorJournal } from "../errors/journal.js";
import { callModelSimple, callModelStream, type StreamCallbacks } from "../shared/pi-bridge.js";
import {
  buildModelAliasIndex,
  resolveModelForEngine,
  type ModelAliasIndex,
} from "../router/model-selection.js";
import { runWithModelFallback } from "../router/model-fallback.js";
import { filterSkillsForAgent, formatSkillsForPrompt, type Skill } from "../shared/skill-loader.js";
import { guardOutput } from "../security/guards.js";
import { TokenTracker, estimateTokens } from "../monitoring/token-tracker.js";

export interface AgentDeps {
  auditLog: AuditLog;
  errorJournal: ErrorJournal;
  projectRoot: string;
  modelsRegistry: ModelsRegistry;
  allSkills: Map<string, Skill>;
  bootstrapContext: string;
  tokenTracker: TokenTracker;
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
  private aliasIndex: ModelAliasIndex;

  constructor(id: AgentId, config: AgentConfig, deps: AgentDeps) {
    this.id = id;
    this.config = config;
    this.deps = deps;
    this.aliasIndex = buildModelAliasIndex(deps.modelsRegistry);
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
   * Resolve the model to use for a task.
   * Uses the route's engine preference (local/cloud), with fallback chain.
   */
  protected resolveModel(task: Task): ModelRef {
    const engine = task.route.model; // "local" or "cloud"
    return resolveModelForEngine(engine, this.deps.modelsRegistry, this.aliasIndex);
  }

  /**
   * Get the fallback model (opposite engine).
   */
  protected resolveFallbackModel(task: Task): ModelRef {
    const fallbackEngine = task.route.model === "local" ? "cloud" : "local";
    return resolveModelForEngine(fallbackEngine, this.deps.modelsRegistry, this.aliasIndex);
  }

  /**
   * Call a model with automatic fallback.
   * Builds system prompt from bootstrap context + agent skills.
   */
  protected async callModel(
    task: Task,
    prompt: string,
    opts?: { systemPrompt?: string; maxTokens?: number; temperature?: number },
  ): Promise<string> {
    const primary = this.resolveModel(task);
    const fallback = this.resolveFallbackModel(task);

    const systemPrompt = opts?.systemPrompt ?? this.buildSystemPrompt();
    const callStart = Date.now();
    const inputText = (systemPrompt ?? "") + prompt;

    const { result } = await runWithModelFallback({
      primary,
      fallbacks: [fallback],
      run: (provider, model) =>
        callModelSimple({ provider, model }, prompt, {
          systemPrompt,
          maxTokens: opts?.maxTokens ?? 4096,
          temperature: opts?.temperature,
        }),
    });

    // Track token usage
    await this.deps.tokenTracker.record({
      agent: this.id,
      provider: primary.provider,
      model: primary.model,
      engine: task.route.model,
      inputTokens: estimateTokens(inputText),
      outputTokens: estimateTokens(result),
      durationMs: Date.now() - callStart,
      cached: false,
    });

    return result;
  }

  /**
   * Stream a model response with callbacks.
   */
  protected async streamModel(
    task: Task,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    opts?: {
      systemPrompt?: string;
      maxTokens?: number;
      temperature?: number;
      callbacks?: StreamCallbacks;
    },
  ): Promise<string> {
    const model = this.resolveModel(task);
    const systemPrompt = opts?.systemPrompt ?? this.buildSystemPrompt();
    const callStart = Date.now();
    const inputText = (systemPrompt ?? "") + messages.map((m) => m.content).join("");

    const result = await callModelStream(model, messages, {
      systemPrompt,
      maxTokens: opts?.maxTokens ?? 4096,
      temperature: opts?.temperature,
      callbacks: opts?.callbacks,
    });

    // Track token usage
    await this.deps.tokenTracker.record({
      agent: this.id,
      provider: model.provider,
      model: model.model,
      engine: task.route.model,
      inputTokens: estimateTokens(inputText),
      outputTokens: estimateTokens(result),
      durationMs: Date.now() - callStart,
      cached: false,
    });

    return result;
  }

  /**
   * Build the system prompt for this agent, including bootstrap context and skills.
   */
  protected buildSystemPrompt(): string {
    const skills = filterSkillsForAgent(
      this.deps.allSkills,
      this.config.tools,
      this.config.skills,
    );
    const skillsSection = formatSkillsForPrompt(skills);

    return [
      this.deps.bootstrapContext,
      "",
      `You are the ${this.id} agent. Your tools: ${this.config.tools.join(", ") || "none"}.`,
      `Actions requiring approval: ${this.config.approvalRequired.join(", ") || "none"}.`,
      "",
      skillsSection,
    ].join("\n");
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

      const rawOutput = await fn();

      // Guard: check for leaked secrets in output
      const { safe, redacted, secretsFound } = guardOutput(rawOutput);
      const output = redacted;

      if (!safe) {
        await this.audit({
          action: "output_redacted",
          output: `Redacted ${secretsFound} secret(s) from response`,
        });
        await this.captureError({
          type: "tool_failure",
          model: task.route.model,
          task: task.input,
          context: { secretsFound, intent: task.classification.intent },
        });
      }

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
