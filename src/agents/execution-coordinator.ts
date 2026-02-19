/**
 * Execution Coordinator - 执行协调器
 *
 * 协调决策引擎与工具执行，实现自主决策的强制执行
 * 在工具执行前后进行干预，自动调整执行策略
 */

import { createSubsystemLogger } from "../logging/subsystem.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  getDecisionContext,
  type DecisionContext,
  type ExecutionInstruction,
} from "./decision-context.js";
import {
  DecisionEngine,
  type TaskAnalysis,
  type StrategySelection,
  type ExecutionEvaluation,
} from "./decision-engine.js";

const log = createSubsystemLogger("coordinator");

/**
 * 协调器配置
 */
export type CoordinatorConfig = {
  enableAutoStrategy: boolean;
  enableAutoEvaluation: boolean;
  enableFeedbackLoop: boolean;
  maxAutoIterations: number;
  confidenceThreshold: number;
};

const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  enableAutoStrategy: true,
  enableAutoEvaluation: true,
  enableFeedbackLoop: true,
  maxAutoIterations: 5,
  confidenceThreshold: 0.7,
};

/**
 * 工具执行上下文
 */
export type ToolExecutionContext = {
  toolName: string;
  toolCallId: string;
  args: Record<string, unknown>;
  timestamp: number;
};

/**
 * 协调器响应
 */
export type CoordinatorResponse = {
  shouldExecute: boolean;
  modifiedArgs?: Record<string, unknown>;
  instruction?: ExecutionInstruction;
  analysis?: TaskAnalysis;
  strategy?: StrategySelection;
  evaluation?: ExecutionEvaluation;
  nextRecommendedTool?: string;
  stopReason?: string;
};

/**
 * 执行协调器
 *
 * 在 Agent 工具执行过程中进行协调，实现自主决策
 */
export class ExecutionCoordinator {
  private readonly config: CoordinatorConfig;
  private readonly decisionContext: DecisionContext;
  private readonly engine: DecisionEngine;
  private currentAnalysis?: TaskAnalysis;
  private currentStrategy?: StrategySelection;
  private iterationCount = 0;

  constructor(options?: {
    coordinatorConfig?: Partial<CoordinatorConfig>;
    openClawConfig?: OpenClawConfig;
    agentSessionKey?: string;
  }) {
    this.config = { ...DEFAULT_COORDINATOR_CONFIG, ...options?.coordinatorConfig };
    this.decisionContext = getDecisionContext();
    this.engine = new DecisionEngine({
      openClawConfig: options?.openClawConfig,
      agentSessionKey: options?.agentSessionKey,
    });
  }

  /**
   * 初始化会话
   *
   * 在会话开始时调用，创建初始目标和策略
   */
  async initializeSession(userMessage: string): Promise<CoordinatorResponse> {
    log.debug(`Initializing session with message: "${userMessage.substring(0, 50)}..."`);

    this.iterationCount = 0;

    const analysis = await this.engine.analyzeTask(userMessage);
    this.currentAnalysis = analysis;

    if (analysis.clarificationNeeded && analysis.clarificationQuestions) {
      return {
        shouldExecute: false,
        analysis,
        stopReason: "clarification_needed",
        instruction: {
          requestClarification: true,
          clarificationQuestion: analysis.clarificationQuestions[0],
        },
      };
    }

    const strategy = await this.engine.selectStrategy(analysis);
    this.currentStrategy = strategy;

    this.engine.createGoalFromTask(userMessage);
    const instruction = this.engine.generateInstruction({ analysis, strategy });

    log.debug(
      `Session initialized: level=${strategy.level}, primaryTool=${strategy.primaryTool}`,
    );

    return {
      shouldExecute: true,
      analysis,
      strategy,
      instruction,
      nextRecommendedTool: strategy.executionOrder[0],
    };
  }

  /**
   * 工具执行前处理
   *
   * 在工具执行前进行干预，决定是否执行、如何执行
   */
  async beforeToolExecution(ctx: ToolExecutionContext): Promise<CoordinatorResponse> {
    const { toolName, args } = ctx;

    log.debug(`Before tool execution: ${toolName}`);

    if (this.iterationCount >= this.config.maxAutoIterations) {
      log.debug(`Max iterations reached: ${this.iterationCount}`);
      return {
        shouldExecute: false,
        stopReason: "max_iterations_reached",
      };
    }

    const instruction = this.decisionContext.getInstruction();

    if (instruction.stopExecution) {
      log.debug("Execution stopped by instruction");
      return {
        shouldExecute: false,
        stopReason: "execution_stopped",
        instruction,
      };
    }

    if (instruction.useTools && instruction.useTools.length > 0) {
      if (!instruction.useTools.includes(toolName)) {
        log.debug(
          `Tool ${toolName} not in recommended list: ${instruction.useTools.join(",")}`,
        );
      }
    }

    const modifiedArgs = this.applyInstructionToArgs(toolName, args, instruction);

    return {
      shouldExecute: true,
      modifiedArgs,
      instruction,
      analysis: this.currentAnalysis,
      strategy: this.currentStrategy,
    };
  }

  /**
   * 工具执行后处理
   *
   * 评估执行结果，决定下一步行动
   */
  async afterToolExecution(params: {
    toolName: string;
    toolCallId: string;
    args: Record<string, unknown>;
    result: unknown;
    duration: number;
  }): Promise<CoordinatorResponse> {
    const { toolName, toolCallId, args, result, duration } = params;

    log.debug(`After tool execution: ${toolName}`);

    this.iterationCount++;

    const evaluation = await this.engine.evaluateExecution({
      toolName,
      toolCallId,
      args,
      result,
      duration,
    });

    this.engine.updateGoalProgress(evaluation);

    const instruction = this.engine.generateInstruction({
      analysis: this.currentAnalysis ?? (await this.engine.analyzeTask("")),
      strategy: this.currentStrategy ?? (await this.engine.selectStrategy(await this.engine.analyzeTask(""))),
      evaluation,
    });

    let nextRecommendedTool: string | undefined;
    let shouldContinue = true;
    let stopReason: string | undefined;

    switch (evaluation.nextAction) {
      case "complete":
        shouldContinue = false;
        stopReason = "task_completed";
        break;

      case "clarify":
        shouldContinue = false;
        stopReason = "clarification_needed";
        break;

      case "escalate":
        instruction.thinkingLevel = "high";
        nextRecommendedTool = this.engine.getRecommendedNextTool();
        break;

      case "retry":
        nextRecommendedTool = toolName;
        break;

      case "continue":
        nextRecommendedTool = this.engine.getRecommendedNextTool();
        break;
    }

    log.debug(
      `Evaluation complete: nextAction=${evaluation.nextAction}, shouldContinue=${shouldContinue}`,
    );

    return {
      shouldExecute: shouldContinue,
      instruction,
      evaluation,
      nextRecommendedTool,
      stopReason,
    };
  }

  /**
   * 获取当前状态
   */
  getCurrentState(): {
    iterationCount: number;
    analysis?: TaskAnalysis;
    strategy?: StrategySelection;
    instruction: ExecutionInstruction;
    metrics: ReturnType<DecisionContext["getMetrics"]>;
  } {
    return {
      iterationCount: this.iterationCount,
      analysis: this.currentAnalysis,
      strategy: this.currentStrategy,
      instruction: this.decisionContext.getInstruction(),
      metrics: this.decisionContext.getMetrics(),
    };
  }

  /**
   * 重置协调器状态
   */
  reset(): void {
    this.iterationCount = 0;
    this.currentAnalysis = undefined;
    this.currentStrategy = undefined;
    this.decisionContext.clearInstruction();
    log.debug("Coordinator reset");
  }

  /**
   * 检查是否应该继续自动执行
   */
  shouldAutoContinue(): boolean {
    if (this.iterationCount >= this.config.maxAutoIterations) {
      return false;
    }

    const instruction = this.decisionContext.getInstruction();
    if (instruction.stopExecution || instruction.requestClarification) {
      return false;
    }

    return true;
  }

  /**
   * 获取下一个推荐工具
   */
  getNextRecommendedTool(): string | undefined {
    return this.engine.getRecommendedNextTool();
  }

  /**
   * 将指令应用到工具参数
   */
  private applyInstructionToArgs(
    toolName: string,
    args: Record<string, unknown>,
    instruction: ExecutionInstruction,
  ): Record<string, unknown> {
    const modifiedArgs = { ...args };

    if (toolName === "self_rag" || toolName === "memory_search") {
      if (instruction.qualityThreshold !== undefined && modifiedArgs.minScore === undefined) {
        modifiedArgs.minScore = instruction.qualityThreshold * 0.5;
      }
    }

    if (toolName === "agentic_workflow") {
      if (instruction.maxIterations !== undefined && modifiedArgs.maxIterations === undefined) {
        modifiedArgs.maxIterations = instruction.maxIterations;
      }
      if (instruction.qualityThreshold !== undefined && modifiedArgs.qualityThreshold === undefined) {
        modifiedArgs.qualityThreshold = instruction.qualityThreshold;
      }
    }

    if (toolName === "dynamic_reasoning") {
      // 可以根据策略调整分析深度
    }

    return modifiedArgs;
  }
}

/**
 * 全局协调器实例
 */
let globalCoordinator: ExecutionCoordinator | null = null;

/**
 * 获取全局协调器
 */
export function getExecutionCoordinator(options?: {
  coordinatorConfig?: Partial<CoordinatorConfig>;
  openClawConfig?: OpenClawConfig;
  agentSessionKey?: string;
}): ExecutionCoordinator {
  if (!globalCoordinator) {
    globalCoordinator = new ExecutionCoordinator(options);
  }
  return globalCoordinator;
}

/**
 * 重置全局协调器
 */
export function resetExecutionCoordinator(): void {
  if (globalCoordinator) {
    globalCoordinator.reset();
  }
  globalCoordinator = null;
  log.debug("Global coordinator reset");
}

/**
 * 创建协调器工具
 *
 * 暴露协调器功能给 Agent
 */
export function createCoordinatorTool(options?: {
  config?: OpenClawConfig;
  agentSessionKey?: string;
}): unknown {
  const cfg = options?.config;
  if (!cfg) {
    return null;
  }

  return {
    name: "execution_coordinator",
    label: "Execution Coordinator",
    description:
      "Coordinate tool execution with autonomous decision making. Call at session start and after each tool execution to get guidance.",
    parameters: {
      type: "object",
      properties: {
        phase: {
          type: "string",
          enum: ["init", "before", "after", "status"],
          description: "Execution phase",
        },
        userMessage: {
          type: "string",
          description: "User message (for init phase)",
        },
        toolName: {
          type: "string",
          description: "Tool name (for before/after phases)",
        },
        toolCallId: {
          type: "string",
          description: "Tool call ID (for after phase)",
        },
        args: {
          type: "object",
          description: "Tool arguments",
        },
        result: {
          type: "object",
          description: "Tool result (for after phase)",
        },
        duration: {
          type: "number",
          description: "Execution duration in ms",
        },
      },
      required: ["phase"],
    },
    execute: async (_toolCallId: string, params: Record<string, unknown>) => {
      const phase = params.phase as string;
      const coordinator = getExecutionCoordinator({
        openClawConfig: cfg,
        agentSessionKey: options?.agentSessionKey,
      });

      try {
        switch (phase) {
          case "init": {
            const userMessage = (params.userMessage as string) ?? "";
            const response = await coordinator.initializeSession(userMessage);
            return {
              content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
              details: response,
            };
          }

          case "before": {
            const ctx: ToolExecutionContext = {
              toolName: (params.toolName as string) ?? "",
              toolCallId: (params.toolCallId as string) ?? "",
              args: (params.args as Record<string, unknown>) ?? {},
              timestamp: Date.now(),
            };
            const response = await coordinator.beforeToolExecution(ctx);
            return {
              content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
              details: response,
            };
          }

          case "after": {
            const response = await coordinator.afterToolExecution({
              toolName: (params.toolName as string) ?? "",
              toolCallId: (params.toolCallId as string) ?? "",
              args: (params.args as Record<string, unknown>) ?? {},
              result: params.result,
              duration: (params.duration as number) ?? 0,
            });
            return {
              content: [{ type: "text", text: JSON.stringify(response, null, 2) }],
              details: response,
            };
          }

          case "status": {
            const state = coordinator.getCurrentState();
            return {
              content: [{ type: "text", text: JSON.stringify(state, null, 2) }],
              details: state,
            };
          }

          default:
            return {
              content: [{ type: "text", text: `Unknown phase: ${phase}` }],
              details: { error: `Unknown phase: ${phase}` },
            };
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`Coordinator error: ${message}`);
        return {
          content: [{ type: "text", text: `Error: ${message}` }],
          details: { error: message },
        };
      }
    },
  };
}
