import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { spawnSubagentDirect } from "../subagent-spawn.js";
import type { SpawnSubagentContext } from "../subagent-spawn.js";
import { ModelRouter } from "./model-router.js";
import { ResultSynthesizer } from "./synthesizer.js";
import type {
  SocietyOfMindsTask,
  SocietyOfMindsResult,
  ModelResult,
} from "./types.js";

export type SocietyOfMindsContext = SpawnSubagentContext;

/**
 * Orchestrates multi-model collaboration using the "Society of Minds" pattern.
 * Coordinates multiple AI models working on the same problem and synthesizes results.
 */
export class SocietyOfMindsOrchestrator {
  private config: OpenClawConfig;
  private ctx: SocietyOfMindsContext;

  constructor(ctx: SocietyOfMindsContext) {
    this.config = loadConfig();
    this.ctx = ctx;
  }

  /**
   * Executes a task using multiple models in parallel or sequential mode.
   */
  async execute(task: SocietyOfMindsTask): Promise<SocietyOfMindsResult> {
    const strategy = task.strategy || this.getDefaultStrategy();
    const models = task.models || this.getAvailableModels();
    const maxConcurrent = task.maxConcurrent || 4;

    // Route task to appropriate models
    const routingDecisions = ModelRouter.routeTask(
      task.task,
      models,
      strategy,
    );
    const selectedModels = routingDecisions.map((d) => d.model);

    // Execute based on strategy
    let modelResults: ModelResult[];
    if (strategy === "parallel") {
      modelResults = await this.executeParallel(
        task,
        selectedModels,
        maxConcurrent,
      );
    } else if (strategy === "sequential") {
      modelResults = await this.executeSequential(task, selectedModels);
    } else {
      // debate mode: models discuss before final answer
      modelResults = await this.executeDebate(task, selectedModels);
    }

    // Synthesize results
    const synthesisModel =
      task.synthesisModel ||
      ModelRouter.selectSynthesisModel(task.task);
    const synthesized = ResultSynthesizer.synthesize(
      modelResults,
      task.task,
    );

    return synthesized;
  }

  /**
   * Executes tasks in parallel across multiple models.
   */
  private async executeParallel(
    task: SocietyOfMindsTask,
    models: string[],
    maxConcurrent: number,
  ): Promise<ModelResult[]> {
    const results: ModelResult[] = [];
    const batches: string[][] = [];

    // Split models into batches based on maxConcurrent
    for (let i = 0; i < models.length; i += maxConcurrent) {
      batches.push(models.slice(i, i + maxConcurrent));
    }

    // Execute batches sequentially, but models within batch in parallel
    for (const batch of batches) {
      const batchPromises = batch.map((model) =>
        this.executeModel(task, model),
      );
      const batchResults = await Promise.allSettled(batchPromises);
      for (const result of batchResults) {
        if (result.status === "fulfilled") {
          results.push(result.value);
        } else {
          results.push({
            model: "unknown",
            result: "",
            sessionKey: "",
            runId: "",
            error: result.reason?.message || "Unknown error",
          });
        }
      }
    }

    return results;
  }

  /**
   * Executes tasks sequentially, one model at a time.
   */
  private async executeSequential(
    task: SocietyOfMindsTask,
    models: string[],
  ): Promise<ModelResult[]> {
    const results: ModelResult[] = [];

    for (const model of models) {
      const result = await this.executeModel(task, model);
      results.push(result);
    }

    return results;
  }

  /**
   * Executes in debate mode: models discuss before providing final answer.
   */
  private async executeDebate(
    task: SocietyOfMindsTask,
    models: string[],
  ): Promise<ModelResult[]> {
    // First round: each model provides initial answer
    const initialResults = await this.executeParallel(task, models, models.length);

    // Build debate prompt with all initial answers
    const debatePrompt = this.buildDebatePrompt(task.task, initialResults);

    // Second round: models respond to each other
    const debateTask: SocietyOfMindsTask = {
      ...task,
      task: debatePrompt,
    };
    const debateResults = await this.executeParallel(
      debateTask,
      models,
      models.length,
    );

    // Return combined results
    return [...initialResults, ...debateResults];
  }

  /**
   * Executes a single model on a task.
   */
  private async executeModel(
    task: SocietyOfMindsTask,
    model: string,
  ): Promise<ModelResult> {
    try {
      const spawnResult = await spawnSubagentDirect(
        {
          task: task.task,
          label: task.label || `Society of Minds: ${model}`,
          model,
          cleanup: "keep",
        },
        this.ctx,
      );

      if (spawnResult.status !== "accepted") {
        return {
          model,
          result: "",
          sessionKey: spawnResult.childSessionKey || "",
          runId: spawnResult.runId || "",
          error: spawnResult.error || "Failed to spawn sub-agent",
        };
      }

      // Note: The actual result will come via announce mechanism
      // This is a simplified version - in practice, we'd wait for the announce
      return {
        model,
        result: "Result will be announced when sub-agent completes",
        sessionKey: spawnResult.childSessionKey || "",
        runId: spawnResult.runId || "",
      };
    } catch (error) {
      return {
        model,
        result: "",
        sessionKey: "",
        runId: "",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Builds a debate prompt incorporating all initial model responses.
   */
  private buildDebatePrompt(
    originalTask: string,
    initialResults: ModelResult[],
  ): string {
    const responses = initialResults
      .map(
        (r, idx) =>
          `**${r.model}:**\n${r.result || "(no response yet)"}\n`,
      )
      .join("\n---\n\n");

    return `[Debate Mode] Original task: ${originalTask}

The following models have provided their initial responses. Please review all responses and provide your refined answer, considering the perspectives and insights from other models:

${responses}

Your task: Provide a refined response that synthesizes the best insights from all models while maintaining your own perspective.`;
  }

  /**
   * Gets the default strategy from config.
   */
  private getDefaultStrategy(): "parallel" | "sequential" | "debate" {
    return (
      this.config.agents?.defaults?.societyOfMinds?.strategy || "parallel"
    );
  }

  /**
   * Gets available models from config.
   */
  private getAvailableModels(): string[] {
    return (
      this.config.agents?.defaults?.societyOfMinds?.models || [
        "claude-opus-4",
        "gpt-4",
        "gemini-pro",
        "grok-beta",
      ]
    );
  }
}
