/**
 * Decision Engine - 决策引擎
 *
 * 核心模块：分析任务、决定策略、评估结果、强制执行
 * 实现 Agent 的自主决策能力
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSessionAgentId } from "./agent-scope.js";
import {
  getDecisionContext,
  type DecisionContext,
  type DecisionLevel,
  type ExecutionInstruction,
  type Goal,
  type ToolCallRecord,
} from "./decision-context.js";
import type { AnyAgentTool } from "./tools/common.js";
import { jsonResult, readStringParam } from "./tools/common.js";

const log = createSubsystemLogger("decision-engine");

/**
 * 任务类型
 */
export type TaskType =
  | "information_retrieval"
  | "code_modification"
  | "analysis"
  | "planning"
  | "execution"
  | "clarification"
  | "multi_step";

/**
 * 任务分析结果
 */
export type TaskAnalysis = {
  type: TaskType;
  complexity: number;
  keywords: string[];
  requiredCapabilities: string[];
  suggestedTools: string[];
  estimatedSteps: number;
  contextNeeded: boolean;
  clarificationNeeded: boolean;
  clarificationQuestions?: string[];
};

/**
 * 策略选择结果
 */
export type StrategySelection = {
  level: DecisionLevel;
  primaryTool: string;
  supportingTools: string[];
  executionOrder: string[];
  fallbackStrategy?: string;
  maxIterations: number;
  qualityThreshold: number;
};

/**
 * 执行评估结果
 */
export type ExecutionEvaluation = {
  success: boolean;
  confidence: number;
  completeness: number;
  issues: string[];
  recommendations: string[];
  nextAction: "continue" | "retry" | "escalate" | "clarify" | "complete";
};

/**
 * 决策引擎配置
 */
export type DecisionEngineConfig = {
  enableAutoPlanning: boolean;
  enableAutoExecution: boolean;
  enableFeedbackLoop: boolean;
  maxAutoIterations: number;
  confidenceThreshold: number;
};

const DEFAULT_ENGINE_CONFIG: DecisionEngineConfig = {
  enableAutoPlanning: true,
  enableAutoExecution: true,
  enableFeedbackLoop: true,
  maxAutoIterations: 5,
  confidenceThreshold: 0.7,
};

/**
 * 决策引擎
 */
export class DecisionEngine {
  private readonly config: DecisionEngineConfig;
  private readonly decisionContext: DecisionContext;
  private readonly cfg?: OpenClawConfig;
  private readonly agentId?: string;

  constructor(options?: {
    engineConfig?: Partial<DecisionEngineConfig>;
    openClawConfig?: OpenClawConfig;
    agentSessionKey?: string;
  }) {
    this.config = { ...DEFAULT_ENGINE_CONFIG, ...options?.engineConfig };
    this.decisionContext = getDecisionContext();

    if (options?.openClawConfig && options?.agentSessionKey) {
      this.cfg = options.openClawConfig;
      this.agentId = resolveSessionAgentId({
        sessionKey: options.agentSessionKey,
        config: options.openClawConfig,
      });
    }
  }

  /**
   * 分析任务
   *
   * 核心方法：理解用户请求，判断类型和复杂度
   */
  async analyzeTask(task: string): Promise<TaskAnalysis> {
    log.debug(`Analyzing task: "${task.substring(0, 50)}..."`);

    const keywords = this.extractKeywords(task);
    const type = this.classifyTaskType(task, keywords);
    const complexity = this.assessComplexity(task, keywords);
    const requiredCapabilities = this.identifyCapabilities(type, keywords);
    const suggestedTools = this.suggestTools(type, requiredCapabilities);
    const estimatedSteps = this.estimateSteps(task, complexity);
    const contextNeeded = this.needsContext(type, keywords);
    const clarificationNeeded = this.needsClarification(task, keywords);

    const analysis: TaskAnalysis = {
      type,
      complexity,
      keywords,
      requiredCapabilities,
      suggestedTools,
      estimatedSteps,
      contextNeeded,
      clarificationNeeded,
    };

    if (clarificationNeeded) {
      analysis.clarificationQuestions = this.generateClarificationQuestions(task, keywords);
    }

    log.debug(
      `Task analysis: type=${type}, complexity=${complexity.toFixed(2)}, tools=${suggestedTools.join(",")}`,
    );

    return analysis;
  }

  /**
   * 选择策略
   *
   * 根据任务分析结果选择执行策略
   */
  async selectStrategy(analysis: TaskAnalysis): Promise<StrategySelection> {
    log.debug(`Selecting strategy for task type: ${analysis.type}`);

    let level: DecisionLevel;
    if (analysis.complexity < 0.3) {
      level = "fast";
    } else if (analysis.complexity < 0.6) {
      level = "balanced";
    } else {
      level = "deep";
    }

    const primaryTool = this.selectPrimaryTool(analysis);
    const supportingTools = this.selectSupportingTools(analysis, primaryTool);
    const executionOrder = this.determineExecutionOrder(primaryTool, supportingTools);
    const fallbackStrategy = this.determineFallbackStrategy(analysis);

    const maxIterations = level === "deep" ? 5 : level === "balanced" ? 3 : 1;
    const qualityThreshold = level === "deep" ? 0.9 : level === "balanced" ? 0.8 : 0.6;

    const strategy: StrategySelection = {
      level,
      primaryTool,
      supportingTools,
      executionOrder,
      fallbackStrategy,
      maxIterations,
      qualityThreshold,
    };

    log.debug(
      `Strategy selected: level=${level}, primary=${primaryTool}, iterations=${maxIterations}`,
    );

    return strategy;
  }

  /**
   * 评估执行结果
   *
   * 判断工具执行是否成功，是否需要继续
   */
  async evaluateExecution(params: {
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    result: unknown;
    duration: number;
  }): Promise<ExecutionEvaluation> {
    const { toolName, toolCallId, args, result, duration } = params;

    log.debug(`Evaluating execution: ${toolName}`);

    let success = true;
    let confidence = 0.5;
    let completeness = 0.5;
    const issues: string[] = [];
    const recommendations: string[] = [];

    const resultObj = result as {
      details?: {
        confidence?: number;
        recommendation?: string;
        error?: string;
        status?: string;
        results?: unknown[];
      };
    };

    if (resultObj?.details?.error) {
      success = false;
      issues.push(resultObj.details.error);
    }

    if (resultObj?.details?.confidence !== undefined) {
      confidence = resultObj.details.confidence;
    }

    if (resultObj?.details?.recommendation) {
      recommendations.push(resultObj.details.recommendation);
    }

    if (toolName === "self_rag" || toolName === "multihop_rag") {
      const results = resultObj?.details?.results;
      if (Array.isArray(results) && results.length === 0) {
        completeness = 0.2;
        issues.push("No relevant results found");
        recommendations.push("Try alternative search terms or web_search");
      } else if (Array.isArray(results) && results.length > 0) {
        completeness = Math.min(1, results.length / 3);
      }
    }

    if (confidence < 0.5) {
      issues.push(`Low confidence: ${(confidence * 100).toFixed(0)}%`);
      recommendations.push("Consider additional verification or alternative approach");
    }

    const record: ToolCallRecord = {
      toolName,
      toolCallId,
      timestamp: Date.now(),
      args,
      result,
      success,
      confidence,
      recommendation: recommendations[0],
      duration,
    };

    this.decisionContext.recordToolCall(record);

    let nextAction: ExecutionEvaluation["nextAction"];
    if (!success || confidence < 0.3) {
      nextAction = "retry";
    } else if (confidence >= 0.8 && completeness >= 0.8) {
      nextAction = "complete";
    } else if (issues.length > 2) {
      nextAction = "escalate";
    } else if (completeness < 0.5) {
      nextAction = "continue";
    } else {
      nextAction = "continue";
    }

    const evaluation: ExecutionEvaluation = {
      success,
      confidence,
      completeness,
      issues,
      recommendations,
      nextAction,
    };

    log.debug(
      `Evaluation: success=${success}, confidence=${confidence.toFixed(2)}, nextAction=${nextAction}`,
    );

    return evaluation;
  }

  /**
   * 生成执行指令
   *
   * 将分析结果转换为可执行指令，强制应用到系统
   */
  generateInstruction(params: {
    analysis: TaskAnalysis;
    strategy: StrategySelection;
    evaluation?: ExecutionEvaluation;
  }): ExecutionInstruction {
    const { analysis, strategy, evaluation } = params;

    const instruction: ExecutionInstruction = {
      thinkingLevel: this.mapLevelToThinking(strategy.level),
      useTools: strategy.executionOrder,
      avoidTools: [],
      maxIterations: strategy.maxIterations,
      qualityThreshold: strategy.qualityThreshold,
    };

    if (evaluation) {
      if (evaluation.nextAction === "retry" && strategy.fallbackStrategy) {
        instruction.nextAction = strategy.fallbackStrategy;
      } else if (evaluation.nextAction === "escalate") {
        instruction.thinkingLevel = "high";
        instruction.maxIterations = Math.min(instruction.maxIterations ?? 3, 1);
      } else if (evaluation.nextAction === "complete") {
        instruction.stopExecution = true;
      } else if (evaluation.nextAction === "clarify" && analysis.clarificationQuestions) {
        instruction.requestClarification = true;
        instruction.clarificationQuestion = analysis.clarificationQuestions[0];
      }
    }

    this.decisionContext.setInstruction(instruction);

    log.debug(
      `Instruction generated: thinkingLevel=${instruction.thinkingLevel}, useTools=${instruction.useTools?.join(",")}`,
    );

    return instruction;
  }

  /**
   * 创建目标
   *
   * 从用户请求创建执行目标
   */
  createGoalFromTask(task: string): Goal {
    const goal = this.decisionContext.createGoal({
      description: task,
      priority: 5,
      successCriteria: this.extractSuccessCriteria(task),
    });

    this.decisionContext.setCurrentGoal(goal.id);

    return goal;
  }

  /**
   * 更新目标进度
   */
  updateGoalProgress(evaluation: ExecutionEvaluation): void {
    const goal = this.decisionContext.getCurrentGoal();
    if (!goal) {
      return;
    }

    let progress = goal.progress;

    if (evaluation.success) {
      progress = Math.min(100, progress + 20 * evaluation.confidence);
    }

    if (evaluation.issues.length > 0) {
      progress = Math.max(0, progress - 10);
    }

    if (evaluation.nextAction === "complete") {
      progress = 100;
    }

    this.decisionContext.updateGoalProgress(
      goal.id,
      progress,
      evaluation.issues.length > 0 ? evaluation.issues : undefined,
    );
  }

  /**
   * 获取当前决策状态
   */
  getCurrentState(): {
    goal?: Goal;
    instruction: ExecutionInstruction;
    metrics: ReturnType<DecisionContext["getMetrics"]>;
  } {
    return {
      goal: this.decisionContext.getCurrentGoal(),
      instruction: this.decisionContext.getInstruction(),
      metrics: this.decisionContext.getMetrics(),
    };
  }

  /**
   * 检查是否应该自动继续执行
   */
  shouldAutoContinue(): boolean {
    if (!this.config.enableAutoExecution) {
      return false;
    }

    const state = this.getCurrentState();
    const metrics = state.metrics;

    if (metrics.totalToolCalls >= this.config.maxAutoIterations) {
      log.debug("Auto-continue stopped: max iterations reached");
      return false;
    }

    if (state.instruction.stopExecution) {
      log.debug("Auto-continue stopped: execution stopped");
      return false;
    }

    if (state.instruction.requestClarification) {
      log.debug("Auto-continue stopped: clarification needed");
      return false;
    }

    return true;
  }

  /**
   * 获取推荐的下一步工具
   */
  getRecommendedNextTool(): string | undefined {
    const instruction = this.decisionContext.getInstruction();
    if (!instruction.useTools || instruction.useTools.length === 0) {
      return undefined;
    }

    const recentCalls = this.decisionContext.getRecentToolCalls(5);
    const usedTools = new Set(recentCalls.map((c) => c.toolName));

    for (const tool of instruction.useTools) {
      if (!usedTools.has(tool)) {
        return tool;
      }
    }

    return instruction.useTools[0];
  }

  private extractKeywords(text: string): string[] {
    const stopWords = new Set([
      "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
      "have", "has", "had", "do", "does", "did", "will", "would", "could",
      "should", "may", "might", "must", "can", "need", "to", "of", "in",
      "for", "on", "with", "at", "by", "from", "and", "or", "but", "if",
    ]);

    return text
      .toLowerCase()
      .split(/\s+/)
      .filter((word) => word.length > 2 && !stopWords.has(word))
      .filter((word) => /^[a-z0-9]+$/.test(word));
  }

  private classifyTaskType(task: string, keywords: string[]): TaskType {
    const lowerTask = task.toLowerCase();

    if (/\b(what|how|why|when|where|which|explain|tell me|describe)\b/.test(lowerTask)) {
      return "information_retrieval";
    }

    if (/\b(create|write|modify|update|delete|add|remove|fix|implement|change)\b/.test(lowerTask)) {
      if (/\b(code|file|function|class|module|api)\b/.test(lowerTask)) {
        return "code_modification";
      }
    }

    if (/\b(analyze|analyze|compare|evaluate|assess|review)\b/.test(lowerTask)) {
      return "analysis";
    }

    if (/\b(plan|design|architect|strategy|approach)\b/.test(lowerTask)) {
      return "planning";
    }

    if (/\b(run|execute|start|stop|deploy|build|test)\b/.test(lowerTask)) {
      return "execution";
    }

    if (/\b(first|then|next|finally|step|after|before)\b/.test(lowerTask)) {
      return "multi_step";
    }

    if (keywords.length < 3 || /\?{2,}/.test(task)) {
      return "clarification";
    }

    return "information_retrieval";
  }

  private assessComplexity(task: string, keywords: string[]): number {
    let complexity = 0;

    if (task.length > 200) {
      complexity += 0.2;
    }
    if (task.length > 500) {
      complexity += 0.2;
    }

    if (keywords.length > 5) {
      complexity += 0.1;
    }
    if (keywords.length > 10) {
      complexity += 0.1;
    }

    if (/\b(and|also|additionally|furthermore|moreover)\b/i.test(task)) {
      complexity += 0.15;
    }

    if (/\b(api|database|algorithm|deployment|kubernetes|docker)\b/i.test(task)) {
      complexity += 0.15;
    }

    if (/\b(first|then|next|finally|step|phase)\b/i.test(task)) {
      complexity += 0.1;
    }

    return Math.min(1, complexity);
  }

  private identifyCapabilities(type: TaskType, keywords: string[]): string[] {
    const capabilities: string[] = [];

    if (type === "information_retrieval") {
      capabilities.push("search", "memory_access");
    }

    if (type === "code_modification") {
      capabilities.push("file_operations", "code_analysis");
    }

    if (type === "analysis") {
      capabilities.push("data_processing", "reasoning");
    }

    if (type === "multi_step") {
      capabilities.push("task_decomposition", "sequencing");
    }

    if (keywords.some((k) => ["web", "online", "internet", "latest"].includes(k))) {
      capabilities.push("web_search");
    }

    return capabilities;
  }

  private suggestTools(type: TaskType, capabilities: string[]): string[] {
    const tools: string[] = [];

    if (capabilities.includes("search") || capabilities.includes("memory_access")) {
      tools.push("self_rag", "memory_search");
    }

    if (capabilities.includes("web_search")) {
      tools.push("web_search");
    }

    if (capabilities.includes("task_decomposition")) {
      tools.push("task_decompose");
    }

    if (type === "multi_step") {
      tools.push("agentic_workflow", "task_decompose");
    }

    if (type === "planning") {
      tools.push("agentic_workflow", "dynamic_reasoning");
    }

    if (tools.length === 0) {
      tools.push("self_rag");
    }

    return [...new Set(tools)];
  }

  private estimateSteps(task: string, complexity: number): number {
    const stepIndicators = ["first", "then", "next", "finally", "step", "phase", "before", "after"];
    const count = stepIndicators.filter((word) => new RegExp(`\\b${word}\\b`, "i").test(task)).length;

    return Math.max(1, Math.min(10, Math.ceil(complexity * 5) + count));
  }

  private needsContext(type: TaskType, keywords: string[]): boolean {
    if (type === "information_retrieval" || type === "analysis") {
      return true;
    }

    const contextKeywords = new Set(["previous", "earlier", "before", "history", "context", "prior"]);
    return keywords.some((k) => contextKeywords.has(k));
  }

  private needsClarification(task: string, keywords: string[]): boolean {
    if (keywords.length < 2 && task.length < 20) {
      return true;
    }

    if (/\b(something|somehow|somewhere|someone|thing)\b/i.test(task)) {
      return true;
    }

    return false;
  }

  private generateClarificationQuestions(task: string, keywords: string[]): string[] {
    const questions: string[] = [];

    if (keywords.length < 2) {
      questions.push("Could you provide more details about what you're looking for?");
    }

    if (!/\b(in|on|at|for|about)\b/.test(task.toLowerCase())) {
      questions.push("What specific aspect would you like me to focus on?");
    }

    return questions;
  }

  private selectPrimaryTool(analysis: TaskAnalysis): string {
    if (analysis.suggestedTools.length > 0) {
      return analysis.suggestedTools[0];
    }

    switch (analysis.type) {
      case "information_retrieval":
        return "self_rag";
      case "code_modification":
        return "exec";
      case "analysis":
        return "dynamic_reasoning";
      case "planning":
        return "agentic_workflow";
      case "multi_step":
        return "task_decompose";
      default:
        return "self_rag";
    }
  }

  private selectSupportingTools(analysis: TaskAnalysis, primaryTool: string): string[] {
    const supporting: string[] = [];

    if (primaryTool !== "self_rag" && analysis.contextNeeded) {
      supporting.push("self_rag");
    }

    if (primaryTool !== "dynamic_reasoning" && analysis.complexity > 0.5) {
      supporting.push("dynamic_reasoning");
    }

    if (primaryTool !== "agentic_workflow" && analysis.estimatedSteps > 3) {
      supporting.push("agentic_workflow");
    }

    return [...new Set(supporting)];
  }

  private determineExecutionOrder(primaryTool: string, supportingTools: string[]): string[] {
    const order: string[] = [];

    if (supportingTools.includes("dynamic_reasoning")) {
      order.push("dynamic_reasoning");
    }

    if (supportingTools.includes("self_rag")) {
      order.push("self_rag");
    }

    if (!order.includes(primaryTool)) {
      order.push(primaryTool);
    }

    for (const tool of supportingTools) {
      if (!order.includes(tool)) {
        order.push(tool);
      }
    }

    return order;
  }

  private determineFallbackStrategy(analysis: TaskAnalysis): string {
    if (analysis.suggestedTools.includes("web_search")) {
      return "web_search";
    }

    if (analysis.clarificationNeeded) {
      return "request_clarification";
    }

    return "escalate";
  }

  private extractSuccessCriteria(task: string): string[] {
    const criteria: string[] = [];

    if (/\b(answer|explain|describe)\b/i.test(task)) {
      criteria.push("Provide clear and accurate information");
    }

    if (/\b(create|write|implement)\b/i.test(task)) {
      criteria.push("Produce working solution");
    }

    if (/\b(fix|solve|resolve)\b/i.test(task)) {
      criteria.push("Issue resolved and verified");
    }

    if (criteria.length === 0) {
      criteria.push("Task completed successfully");
    }

    return criteria;
  }

  private mapLevelToThinking(level: DecisionLevel): "off" | "low" | "medium" | "high" {
    switch (level) {
      case "fast":
        return "off";
      case "balanced":
        return "low";
      case "deep":
        return "medium";
    }
  }
}

/**
 * 创建决策引擎工具
 *
 * 暴露给 Agent 的工具接口
 */
export function createDecisionEngineTool(options?: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): AnyAgentTool | null {
  const cfg = options?.config;
  if (!cfg) {
    return null;
  }

  return {
    name: "decision_engine",
    label: "Decision Engine",
    description:
      "Analyze task, select strategy, and get execution guidance. This is the core autonomous decision tool that provides structured analysis, tool recommendations, and execution instructions.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["analyze", "strategy", "evaluate", "status"],
          description: "Action: analyze (task), strategy (select tools), evaluate (results), status (current state)",
        },
        task: {
          type: "string",
          description: "The task to analyze (required for 'analyze' action)",
        },
        toolName: {
          type: "string",
          description: "Tool name (required for 'evaluate' action)",
        },
        toolCallId: {
          type: "string",
          description: "Tool call ID (required for 'evaluate' action)",
        },
        result: {
          type: "object",
          description: "Tool execution result (required for 'evaluate' action)",
        },
        duration: {
          type: "number",
          description: "Execution duration in ms (for 'evaluate' action)",
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId, params) => {
      const action = readStringParam(params, "action", { required: true });

      const engine = new DecisionEngine({
        openClawConfig: cfg,
        agentSessionKey: options?.agentSessionKey,
      });

      try {
        switch (action) {
          case "analyze": {
            const task = readStringParam(params, "task", { required: true });
            const analysis = await engine.analyzeTask(task);

            const goal = engine.createGoalFromTask(task);
            const strategy = await engine.selectStrategy(analysis);
            const instruction = engine.generateInstruction({ analysis, strategy });

            return jsonResult({
              action: "analyze",
              analysis: {
                type: analysis.type,
                complexity: Math.round(analysis.complexity * 100) / 100,
                keywords: analysis.keywords.slice(0, 10),
                contextNeeded: analysis.contextNeeded,
                clarificationNeeded: analysis.clarificationNeeded,
                clarificationQuestions: analysis.clarificationQuestions,
              },
              strategy: {
                level: strategy.level,
                primaryTool: strategy.primaryTool,
                supportingTools: strategy.supportingTools,
                executionOrder: strategy.executionOrder,
                maxIterations: strategy.maxIterations,
              },
              instruction,
              goal: {
                id: goal.id,
                description: goal.description,
                successCriteria: goal.successCriteria,
              },
            });
          }

          case "strategy": {
            const task = readStringParam(params, "task", { required: false }) ?? "";
            const analysis = await engine.analyzeTask(task);
            const strategy = await engine.selectStrategy(analysis);

            return jsonResult({
              action: "strategy",
              strategy: {
                level: strategy.level,
                primaryTool: strategy.primaryTool,
                supportingTools: strategy.supportingTools,
                executionOrder: strategy.executionOrder,
                fallbackStrategy: strategy.fallbackStrategy,
                maxIterations: strategy.maxIterations,
                qualityThreshold: strategy.qualityThreshold,
              },
            });
          }

          case "evaluate": {
            const toolName = readStringParam(params, "toolName", { required: true });
            const toolCallId = readStringParam(params, "toolCallId", { required: true });
            const result = params.result as Record<string, unknown>;
            const duration = (params.duration as number) ?? 0;

            const evaluation = await engine.evaluateExecution({
              toolName,
              toolCallId,
              args: {},
              result,
              duration,
            });

            engine.updateGoalProgress(evaluation);

            const state = engine.getCurrentState();
            const instruction = engine.generateInstruction({
              analysis: await engine.analyzeTask(state.goal?.description ?? ""),
              strategy: await engine.selectStrategy(await engine.analyzeTask(state.goal?.description ?? "")),
              evaluation,
            });

            return jsonResult({
              action: "evaluate",
              evaluation: {
                success: evaluation.success,
                confidence: evaluation.confidence,
                completeness: evaluation.completeness,
                issues: evaluation.issues,
                recommendations: evaluation.recommendations,
                nextAction: evaluation.nextAction,
              },
              instruction,
              recommendedNextTool: engine.getRecommendedNextTool(),
              shouldAutoContinue: engine.shouldAutoContinue(),
            });
          }

          case "status": {
            const state = engine.getCurrentState();

            return jsonResult({
              action: "status",
              goal: state.goal
                ? {
                    id: state.goal.id,
                    description: state.goal.description,
                    status: state.goal.status,
                    progress: state.goal.progress,
                    blockers: state.goal.blockers,
                  }
                : null,
              instruction: state.instruction,
              metrics: state.metrics,
            });
          }

          default:
            return jsonResult({
              error: `Unknown action: ${action}`,
              validActions: ["analyze", "strategy", "evaluate", "status"],
            });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Decision engine error: ${message}`);
        return jsonResult({
          error: message,
          action,
        });
      }
    },
  };
}

export { DecisionEngine as DecisionEngineClass };
