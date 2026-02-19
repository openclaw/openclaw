import type { SocietyOfMindsTask, ModelRouterDecision } from "./types.js";

/**
 * Routes tasks to appropriate models based on task characteristics.
 * Uses heuristics to select the best model(s) for a given task.
 */
export class ModelRouter {
  /**
   * Determines which models should handle a task based on its characteristics.
   */
  static routeTask(
    task: string,
    availableModels: string[],
    strategy?: string,
  ): ModelRouterDecision[] {
    const taskLower = task.toLowerCase();
    const decisions: ModelRouterDecision[] = [];

    // If specific models are requested, use those
    if (availableModels.length > 0) {
      for (const model of availableModels) {
        decisions.push({
          model,
          reason: "explicitly requested",
        });
      }
      return decisions;
    }

    // Default routing logic based on task content
    const isCodingTask =
      taskLower.includes("code") ||
      taskLower.includes("function") ||
      taskLower.includes("class") ||
      taskLower.includes("implement") ||
      taskLower.includes("debug") ||
      taskLower.includes("fix");

    const isResearchTask =
      taskLower.includes("research") ||
      taskLower.includes("analyze") ||
      taskLower.includes("investigate") ||
      taskLower.includes("find") ||
      taskLower.includes("search");

    const isCreativeTask =
      taskLower.includes("write") ||
      taskLower.includes("create") ||
      taskLower.includes("generate") ||
      taskLower.includes("story") ||
      taskLower.includes("content");

    const isMathTask =
      taskLower.includes("math") ||
      taskLower.includes("calculate") ||
      taskLower.includes("solve") ||
      taskLower.includes("equation");

    // Route based on task type
    if (isCodingTask) {
      // Prefer coding-focused models
      decisions.push({
        model: "claude-opus-4",
        reason: "coding task - Claude excels at code generation",
      });
      decisions.push({
        model: "gpt-4",
        reason: "coding task - GPT-4 provides good code quality",
      });
    } else if (isResearchTask) {
      // Prefer models with web access
      decisions.push({
        model: "grok-beta",
        reason: "research task - Grok has deep X/Twitter integration",
      });
      decisions.push({
        model: "gemini-pro",
        reason: "research task - Gemini has strong web search capabilities",
      });
    } else if (isCreativeTask) {
      // Prefer creative models
      decisions.push({
        model: "claude-opus-4",
        reason: "creative task - Claude excels at writing",
      });
      decisions.push({
        model: "gpt-4",
        reason: "creative task - GPT-4 provides good creative output",
      });
    } else if (isMathTask) {
      // Prefer math-focused models
      decisions.push({
        model: "claude-opus-4",
        reason: "math task - Claude excels at mathematical reasoning",
      });
      decisions.push({
        model: "gemini-pro",
        reason: "math task - Gemini has strong mathematical capabilities",
      });
    } else {
      // Default: use all available models
      decisions.push({
        model: "claude-opus-4",
        reason: "general task - Claude provides high-quality reasoning",
      });
      decisions.push({
        model: "gpt-4",
        reason: "general task - GPT-4 provides balanced capabilities",
      });
      decisions.push({
        model: "gemini-pro",
        reason: "general task - Gemini provides diverse perspectives",
      });
    }

    return decisions;
  }

  /**
   * Selects the best model for synthesis based on task complexity.
   */
  static selectSynthesisModel(
    task: string,
    defaultModel?: string,
  ): string {
    if (defaultModel) {
      return defaultModel;
    }

    // Default to Claude for synthesis as it's good at combining perspectives
    return "claude-opus-4";
  }
}
